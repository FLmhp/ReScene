const { withAppBuildGradle } = require("expo/config-plugins");

const marker = "// ReScene release signing (environment only)";
const variables = [
  "RESCENE_ANDROID_KEYSTORE_PATH",
  "RESCENE_ANDROID_KEYSTORE_PASSWORD",
  "RESCENE_ANDROID_KEY_ALIAS",
  "RESCENE_ANDROID_KEY_PASSWORD",
];

module.exports = function withAndroidReleaseSigning(config) {
  return withAppBuildGradle(config, (mod) => {
    if (mod.modResults.language !== "groovy") {
      throw new Error("ReScene release signing requires a Groovy app build.gradle");
    }
    if (mod.modResults.contents.includes(marker)) return mod;
    mod.modResults.contents += `
${marker}
def resceneSigningNames = ${JSON.stringify(variables)}
def resceneSigning = resceneSigningNames.collectEntries { [(it): providers.environmentVariable(it).orNull] }
def resceneSigningMissing = resceneSigningNames.findAll { !resceneSigning[it] }

android {
    signingConfigs {
        resceneRelease {
            if (resceneSigningMissing.isEmpty()) {
                storeFile file(resceneSigning['RESCENE_ANDROID_KEYSTORE_PATH'])
                storePassword resceneSigning['RESCENE_ANDROID_KEYSTORE_PASSWORD']
                keyAlias resceneSigning['RESCENE_ANDROID_KEY_ALIAS']
                keyPassword resceneSigning['RESCENE_ANDROID_KEY_PASSWORD']
            }
        }
    }
    buildTypes {
        release {
            signingConfig signingConfigs.resceneRelease
        }
    }
}

gradle.taskGraph.whenReady { graph ->
    def releaseTask = graph.allTasks.any {
        it.name ==~ /(?i)^(assemble|bundle|package|validateSigning).*release.*/
    }
    if (releaseTask && !resceneSigningMissing.isEmpty()) {
        throw new GradleException(
            'Release signing requires environment variables: ' + resceneSigningMissing.join(', ')
        )
    }
}
`;
    return mod;
  });
};
