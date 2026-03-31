const loadedEnvFiles = new Set<string>();

function parseEnvLine(line: string): [string, string] | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) {
    return null;
  }

  const separatorIndex = trimmed.indexOf("=");
  if (separatorIndex <= 0) {
    return null;
  }

  const key = trimmed.slice(0, separatorIndex).trim();
  let value = trimmed.slice(separatorIndex + 1).trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }

  return [key, value];
}

export async function loadLocalEnv(): Promise<void> {
  const envPath = new URL("../.env", import.meta.url).pathname;
  if (loadedEnvFiles.has(envPath)) {
    return;
  }

  try {
    const text = await Deno.readTextFile(envPath);
    for (const line of text.split(/\r?\n/)) {
      const entry = parseEnvLine(line);
      if (!entry) continue;

      const [key, value] = entry;
      if (!Deno.env.get(key)) {
        Deno.env.set(key, value);
      }
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) {
      throw error;
    }
  }

  loadedEnvFiles.add(envPath);
}

export async function getConfigValue(name: string, fallback?: string): Promise<string> {
  await loadLocalEnv();
  const value = Deno.env.get(name) ?? fallback;
  if (!value) {
    throw new Error(`Missing required configuration value ${name}`);
  }
  return value;
}
