const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

// Exercise the actual screen with deterministic hook and WebView stand-ins.
const hooks = [];
let cursor = 0;
let effects = [];
let manifest;
const injections = [];
const depsChanged = (a, b) => !a || a.some((value, index) => value !== b[index]);
const react = {
  useRef(value) { const i = cursor++; return hooks[i] ??= { current: value }; },
  useState(value) {
    const i = cursor++;
    if (!(i in hooks)) hooks[i] = typeof value === 'function' ? value() : value;
    return [hooks[i], (next) => { hooks[i] = typeof next === 'function' ? next(hooks[i]) : next; }];
  },
  useCallback(fn, deps) {
    const i = cursor++;
    if (!hooks[i] || depsChanged(hooks[i].deps, deps)) hooks[i] = { fn, deps };
    return hooks[i].fn;
  },
  useEffect(fn, deps) {
    const i = cursor++;
    if (!hooks[i] || depsChanged(hooks[i].deps, deps)) effects.push(() => {
      hooks[i]?.cleanup?.();
      hooks[i] = { deps, cleanup: fn() };
    });
  },
};
const element = (type, props) => ({ type, props: props || {} });
const modules = {
  react,
  'react/jsx-runtime': { jsx: element, jsxs: element, Fragment: 'Fragment' },
  'react-native': { ActivityIndicator: 'ActivityIndicator', Text: 'Text', View: 'View' },
  'react-native-webview': { WebView: 'WebView' },
  '../api': { webBaseUrl: 'https://app.example.com', client: { getManifest: (id) => manifest(id) } },
  '../appearance': { useAppearance: () => ({ theme: { bg: '#fff' }, dark: false }) },
  '../ui': { Button: 'Button', useTextStyles: () => ({ error: {} }) },
};
const source = fs.readFileSync('apps/mobile/src/screens/ViewerScreen.tsx', 'utf8');
const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const screenExports = {};
vm.runInNewContext(output, { exports: screenExports, require: (name) => { if (!(name in modules)) throw Error(name); return modules[name]; }, URL, JSON, Error });
let props = { reconstructionId: 'scene-a', onBack() {} };
function render() {
  cursor = 0;
  effects = [];
  let tree = screenExports.ViewerScreen(props);
  if (effects.length) {
    const pending = effects;
    effects = [];
    pending.forEach((effect) => effect());
    cursor = 0;
    tree = screenExports.ViewerScreen(props);
  }
  return tree;
}
function find(tree, type) {
  if (!tree || typeof tree !== 'object') return undefined;
  if (tree.type === type) return tree;
  for (const child of [tree.props?.children].flat(Infinity)) {
    const found = find(child, type);
    if (found) return found;
  }
}
function message(id, requestId, url = 'https://app.example.com/viewer') {
  return { nativeEvent: { url, data: JSON.stringify({ type: 'RESCENE_MANIFEST_REQUEST', reconstructionId: id, requestId }) } };
}
async function tick() { await Promise.resolve(); await Promise.resolve(); }
(async () => {
  manifest = async () => ({ artifacts: [{ kind: 'spz', url: 'https://oss.example.com/scene?signature=secret' }] });
  let tree = render();
  let view = find(tree, 'WebView');
  assert.equal(view.props.source.uri, 'https://app.example.com/viewer?reconstruction=scene-a&theme=light');
  view.props.ref.current = { injectJavaScript: (script) => injections.push(script) };
  assert.equal(view.props.onShouldStartLoadWithRequest({ url: view.props.source.uri }), true);
  assert.equal(view.props.onShouldStartLoadWithRequest({ url: 'https://app.example.com/viewer-unrelated' }), false);
  view.props.onMessage(message('scene-a', 'foreign', 'https://foreign.example.com'));
  view.props.onMessage(message('scene-a', 'other-document', 'https://app.example.com/viewer-unrelated'));
  await tick();
  assert.deepEqual(injections, [], 'reject messages outside the pinned Viewer document or origin');
  view.props.onMessage(message('scene-a', 'one', 'https://app.example.com'));
  await tick();
  assert.match(injections[0], /signature=secret/);
  assert.match(injections[0], /one/);
  view.props.onHttpError({ nativeEvent: { url: 'https://app.example.com/image.png', statusCode: 404 } });
  assert.ok(find(render(), 'WebView'), 'subresource failure leaves viewer mounted');
  view.props.onHttpError({ nativeEvent: { url: 'https://app.example.com/viewer?reconstruction=scene-a', statusCode: 503 } });
  tree = render();
  assert.ok(find(tree, 'Text'), 'main document HTTP error is visible');
  assert.ok(find(tree, 'Button').props.label === '返回任务');
  const retry = find(find(tree, 'Fragment'), 'Button');
  assert.equal(retry.props.label, '重试 Viewer');
  retry.props.onPress();
  const oldView = view;
  view = find(render(), 'WebView');
  assert.ok(view, 'retry mounts a new viewer');
  oldView.props.onError({ nativeEvent: { url: 'https://app.example.com/viewer' } });
  assert.ok(find(render(), 'WebView'), 'stale error ignored');
  let resolveManifest;
  manifest = () => new Promise((resolve) => { resolveManifest = resolve; });
  view.props.onMessage(message('scene-a', 'late'));
  props = { ...props, reconstructionId: 'scene-b' };
  const next = find(render(), 'WebView');
  next.props.ref.current = { injectJavaScript: (script) => injections.push(script) };
  resolveManifest({ artifacts: [{ kind: 'spz', url: 'https://oss.example.com/old' }] });
  await tick();
  assert.equal(injections.length, 1, 'old scene response never reaches new instance');
  manifest = async () => { throw Error('manifest unavailable'); };
  next.props.onMessage(message('scene-b', 'failed'));
  await tick();
  assert.match(injections[1], /manifest unavailable/);
  next.props.onError({ nativeEvent: { url: 'https://app.example.com/viewer' } });
  assert.ok(find(render(), 'Text'), 'main document network error is visible');
  // The same web page must support bridge-first hosts and older hosts with ?src=.
  const webSource = fs.readFileSync('apps/web/app/viewer/page.tsx', 'utf8');
  const webOutput = ts.transpileModule(webSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  async function webScenario(search, expectedInitial) {
    hooks.length = 0;
    const sent = [];
    let listener;
    const window = {
      location: { search },
      ReactNativeWebView: { postMessage: (data) => sent.push(JSON.parse(data)) },
      addEventListener: (_type, fn) => { listener = fn; },
      removeEventListener: () => {},
      setTimeout: () => 1,
      clearTimeout: () => {},
    };
    const webModules = {
      react, 'react/jsx-runtime': modules['react/jsx-runtime'],
      '@rescene/api-client': { ResceneApiError: class extends Error {}, ResceneClient: class {} },
      '@rescene/viewer': { Viewer: 'Viewer' },
      '@rescene/workbench': { BrandMark: 'BrandMark' },
      '../env': { API_BASE: 'https://api.example.com' },
      '../scene': { messageOf: String, pickScene: () => '' },
    };
    const webExports = {};
    vm.runInNewContext(webOutput, { exports: webExports, require: (name) => webModules[name], window, URLSearchParams, JSON, Error, crypto: { randomUUID: () => `request-${sent.length}` } });
    function renderWeb() {
      cursor = 0;
      effects = [];
      const tree = webExports.default();
      effects.forEach((effect) => effect());
      return tree;
    }
    renderWeb();
    let page = renderWeb();
    if (expectedInitial) {
      assert.equal(find(page, 'Viewer').props.src, expectedInitial);
      assert.equal(sent.length, 0, 'older host renders its initial src');
      find(page, 'Viewer').props.onRetry();
      renderWeb();
    }
    assert.equal(sent.length, 1, 'web page requests a manifest over the bridge');
    assert.equal(sent[0].reconstructionId, 'scene-a');
    listener({ source: null, data: JSON.stringify({ type: 'RESCENE_MANIFEST_RESPONSE', requestId: sent[0].requestId, src: 'https://oss.example.com/fresh' }) });
    page = renderWeb();
    assert.equal(find(page, 'Viewer').props.src, 'https://oss.example.com/fresh');
  }
  await webScenario('?reconstruction=scene-a', null);
  await webScenario('?reconstruction=scene-a&src=https%3A%2F%2Foss.example.com%2Fold', 'https://oss.example.com/old');
  console.log('mobile viewer and web bridge fixture passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
