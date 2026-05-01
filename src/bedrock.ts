export async function createBedrockRuntimeClient(profile: string, region: string): Promise<any> {
  const { BedrockRuntimeClient } = await import("@aws-sdk/client-bedrock-runtime");
  return new BedrockRuntimeClient(await bedrockClientOptions(profile, region));
}

export async function createBedrockAgentRuntimeClient(profile: string, region: string): Promise<any> {
  const { BedrockAgentRuntimeClient } = await import("@aws-sdk/client-bedrock-agent-runtime");
  return new BedrockAgentRuntimeClient(await bedrockClientOptions(profile, region));
}

export function normalizeBedrockResultLocation(location: any): string {
  return (
    location?.s3Location?.uri ??
    location?.webLocation?.url ??
    location?.confluenceLocation?.url ??
    location?.salesforceLocation?.url ??
    location?.sharePointLocation?.url ??
    location?.kendraDocumentLocation?.uri ??
    (location?.customDocumentLocation?.id
      ? `custom-document:${location.customDocumentLocation.id}`
      : undefined) ??
    (location?.sqlLocation?.query ? `sql:${location.sqlLocation.query}` : undefined) ??
    "unknown"
  );
}

async function bedrockClientOptions(profile: string, region: string): Promise<{ region: string; credentials?: any }> {
  const normalizedProfile = profile.trim();
  if (normalizedProfile.length === 0 || normalizedProfile === "default") {
    return { region };
  }

  const { fromIni } = await import("@aws-sdk/credential-providers");
  return {
    region,
    credentials: fromIni({ profile: normalizedProfile }),
  };
}