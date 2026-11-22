import { explainError, ResceneApiError } from "@rescene/api-client";
import type { MemberRole, ProjectMember, ProjectSummary } from "@rescene/schemas";
import { Button, Input, Text, View } from "@tarojs/components";
import Taro, { useDidHide, useDidShow } from "@tarojs/taro";
import { useCallback, useEffect, useRef, useState } from "react";
import { client } from "../../api";
import { openHome } from "../../navigation";

const ROLE = { owner: "所有者", member: "成员（可写）", viewer: "查看者（只读）" } as const;
function message(reason: unknown, fallback: string) { return reason instanceof ResceneApiError ? explainError(reason, reason.detail || fallback) : reason instanceof Error ? reason.message : fallback; }

export function ManagementFocus({ projectId }: { projectId: string }) {
  const [project, setProject] = useState<ProjectSummary | null>(null); const [members, setMembers] = useState<ProjectMember[]>([]);
  const [name, setName] = useState(""); const [email, setEmail] = useState(""); const [role, setRole] = useState<MemberRole>("member");
  const [issued, setIssued] = useState<{ email: string; code: string } | null>(null); const [error, setError] = useState(""); const [membersError, setMembersError] = useState(""); const [notice, setNotice] = useState(""); const [busy, setBusy] = useState(false);
  const context = useRef(0); const lock = useRef(false);
  const loadSummary = useCallback(async () => { try { const p = await client.getProjectSummary(projectId); setProject(p); setName(p.name); setError(""); } catch (reason) { setProject(null); setError(message(reason, "加载项目管理失败。")); } }, [projectId]);
  const loadMembers = useCallback(async () => { try { setMembers(await client.listMembers(projectId)); setMembersError(""); } catch (reason) { setMembersError(message(reason, "加载成员失败。")); } }, [projectId]);
  useDidShow(() => { void loadSummary(); void loadMembers(); });
  useDidHide(() => { context.current++; setIssued(null); });
  useEffect(() => () => { context.current++; }, []);
  useEffect(() => { if (!issued) return; const timer = setTimeout(() => setIssued(null), 120000); return () => clearTimeout(timer); }, [issued]);
  const canManage = project?.effective_role === "owner" || project?.effective_role === "admin";
  async function rename() { if (lock.current || !canManage) return; if (!name.trim()) { setError("项目名称不能为空。"); return; } lock.current = true; setBusy(true); try { await client.updateProject(projectId, name.trim()); setNotice("项目名称已保存。"); await loadSummary(); } catch (reason) { setError(message(reason, "重命名失败。")); } finally { lock.current = false; setBusy(false); } }
  async function remove() { if (!canManage || lock.current) return; const result = await Taro.showModal({ title: "删除项目", content: "确定删除此项目？此操作不可撤销。" }); if (!result.confirm) return; lock.current = true; setBusy(true); try { await client.deleteProject(projectId); const pages = Taro.getCurrentPages(); const home = pages.findIndex((page) => page.route === "pages/index/index"); if (home >= 0) await Taro.navigateBack({ delta: pages.length - 1 - home }); else await openHome(); } catch (reason) { setError(message(reason, "删除项目失败。")); } finally { lock.current = false; setBusy(false); } }
  async function invite() { if (!canManage || !email.trim() || lock.current) return; const generation = context.current; lock.current = true; setBusy(true); setIssued(null); setError(""); try { const result = await client.addMember(projectId, email.trim(), role); if (generation !== context.current) return; setEmail(""); if (result.status === "member") setNotice("该账号已是项目成员，可在成员列表调整角色。"); else if (result.claim_code) setIssued({ email: result.email, code: result.claim_code }); else setNotice("当前服务端版本无法提供领取码。请在升级后重新签发邀请。"); } catch (reason) { if (generation === context.current) setError(message(reason, "签发邀请失败。")); } finally { lock.current = false; setBusy(false); } }
  async function change(member: ProjectMember, action: "role" | "remove") { if (!canManage || member.role === "owner" || lock.current) return; if (action === "remove") { const result = await Taro.showModal({ title: "移除成员", content: `确定移除 ${member.email}？` }); if (!result.confirm) return; } lock.current = true; setBusy(true); try { if (action === "role") await client.updateMemberRole(projectId, member.user_id, member.role === "member" ? "viewer" : "member"); else await client.removeMember(projectId, member.user_id); setMembers(await client.listMembers(projectId)); } catch (reason) { setError(message(reason, "成员操作失败。")); } finally { lock.current = false; setBusy(false); } }
  return <>
    {error ? <View className="card"><Text className="error">{error}</Text>{!project ? <Button className="button ghost" onClick={() => void loadSummary()}>重试</Button> : null}</View> : null}
    {membersError ? <View className="card"><Text className="error">{membersError}</Text><Button className="button ghost" onClick={() => void loadMembers()}>重试成员</Button></View> : null}
    {notice ? <Text>{notice}</Text> : null}
    {project ? <>
      {canManage ? <View className="card"><Text className="label">项目名称</Text><Input className="input" value={name} onInput={(e) => setName(e.detail.value)} /><Button className="button ghost" disabled={busy} onClick={() => void rename()}>保存名称</Button><Button className="button ghost" disabled={busy} onClick={() => void remove()}>删除项目</Button></View> : null}
      <View className="card">
        <Text className="section-heading">项目成员</Text>
        {members.map((member) => <View className="row" key={member.user_id}><Text>{member.email} · {ROLE[member.role]}</Text>{canManage && member.role !== "owner" ? <View><Button className="button ghost compact" disabled={busy} onClick={() => void change(member, "role")}>设为{member.role === "member" ? "查看者" : "成员"}</Button><Button className="button ghost compact" disabled={busy} onClick={() => void change(member, "remove")}>移除</Button></View> : null}</View>)}
      </View>
      {canManage ? <View className="card"><Text className="label">邀请成员邮箱</Text><Input className="input" value={email} placeholder="name@example.com" onInput={(e) => setEmail(e.detail.value)} /><Button className="button ghost" onClick={() => setRole(role === "member" ? "viewer" : "member")}>邀请角色：{ROLE[role]}</Button><Button className="button" disabled={busy || !email.trim()} loading={busy} onClick={() => void invite()}>签发邀请</Button>{issued ? <View><Text>请将领取码交给 {issued.email}。领取码 7 天内有效，仅可使用一次。</Text><Text selectable>{issued.code}</Text></View> : null}</View> : null}
    </> : !error ? <Text className="muted">加载中…</Text> : null}
  </>;
}
