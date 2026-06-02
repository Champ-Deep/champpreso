// v0.14.0: cloud-aware defaults. When CHAMPPRESO_CLOUD=1 (Railway/Render/Fly
// detection or explicit), bind to 0.0.0.0 and skip the browser-open hook.
// HOST env var overrides everything if set explicitly.
function detectCloud(env) {
  return Boolean(
    env.CHAMPPRESO_CLOUD === "1" ||
    env.RAILWAY_ENVIRONMENT ||
    env.RENDER ||
    env.FLY_APP_NAME ||
    env.NIXPACKS_METADATA,
  );
}

export function parseCliArgs(args, env = process.env) {
  const cloud = detectCloud(env);
  const options = {
    host: env.HOST || (cloud ? "0.0.0.0" : "127.0.0.1"),
    port: parsePort(env.PORT),
    openBrowser: !cloud,
    cloud,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--no-open") {
      options.openBrowser = false;
    } else if (arg === "--host" && args[index + 1]) {
      options.host = args[index + 1];
      index += 1;
    } else if (arg === "--port" && args[index + 1]) {
      options.port = parsePort(args[index + 1]);
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument "${arg}".`);
    }
  }

  return options;
}

function parsePort(value) {
  const raw = value || "3210";
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT "${raw}".`);
  }
  return port;
}
