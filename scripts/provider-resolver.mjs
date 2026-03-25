import { resolveJsonPath } from './config-loader.mjs';

function mapProviderFields(source, mapping = {}) {
  const out = {};
  for (const [targetKey, sourceKey] of Object.entries(mapping)) {
    out[targetKey] = source?.[sourceKey];
  }
  return out;
}

export function resolveProvider(config, sourceDocs, providerRef) {
  const providerCfg = config?.providers?.[providerRef];
  if (!providerCfg) throw new Error(`Unknown providerRef: ${providerRef}`);
  const fileRef = providerCfg?.configSource?.fileRef;
  const sourceDoc = sourceDocs?.[fileRef]?.json;
  if (!sourceDoc) throw new Error(`Missing source document for provider ${providerRef}: ${fileRef}`);
  const providerSource = resolveJsonPath(sourceDoc, providerCfg.configSource.jsonPath);
  if (!providerSource) throw new Error(`Could not resolve jsonPath for provider ${providerRef}: ${providerCfg.configSource.jsonPath}`);
  return {
    providerRef,
    role: providerCfg.role,
    raw: providerSource,
    ...mapProviderFields(providerSource, providerCfg.mapping),
  };
}

export function resolveFetchProfile(config, sourceDocs, profileName) {
  const effectiveProfile = profileName || config?.fetch?.activeProfile;
  const profile = config?.fetch?.profiles?.[effectiveProfile];
  if (!profile) throw new Error(`Unknown fetch profile: ${effectiveProfile}`);
  const provider = resolveProvider(config, sourceDocs, profile.providerRef);
  return {
    name: effectiveProfile,
    ...profile,
    provider,
    model: provider.defaultModel,
  };
}

export function resolveAnalysisProfile(config, sourceDocs, profileName) {
  const effectiveProfile = profileName || config?.analysis?.activeProfile;
  const profile = config?.analysis?.profiles?.[effectiveProfile];
  if (!profile) throw new Error(`Unknown analysis profile: ${effectiveProfile}`);
  const provider = resolveProvider(config, sourceDocs, profile.providerRef);
  const modelDef = config?.models?.[profile.modelRef];
  if (!modelDef) throw new Error(`Unknown modelRef: ${profile.modelRef}`);
  if (modelDef.providerRef !== profile.providerRef) {
    throw new Error(`Model ${profile.modelRef} is bound to provider ${modelDef.providerRef}, not ${profile.providerRef}`);
  }
  return {
    name: effectiveProfile,
    ...profile,
    provider,
    modelId: modelDef.modelId,
  };
}
