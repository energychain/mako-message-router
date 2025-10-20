#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { MessageRouter } = require("../index.js");
const pkg = require("../package.json");

const DEFAULT_CONFIG_NAMES = [
  "mako-router.config.js",
  "router.config.js",
  "router.config.cjs",
  "router.config.mjs",
  "router.config.json"
];

function parseArgs(argv) {
  const args = {
    help: false,
    version: false,
    config: process.env.MAKO_ROUTER_CONFIG
  };

  for (let i = 0; i < argv.length; i += 1) {
    const current = argv[i];
    if (current === "--help" || current === "-h") {
      args.help = true;
      continue;
    }
    if (current === "--version" || current === "-v") {
      args.version = true;
      continue;
    }
    if (current === "--config" || current === "-c") {
      args.config = argv[i + 1];
      i += 1;
      continue;
    }
    if (!current.startsWith("-")) {
      args.config = current;
    }
  }

  return args;
}

function printHelp() {
  const helpText = `mako-message-router ${pkg.version}

Verwendung:
  npx mako-message-router --config ./router.config.js

Optionen:
  -c, --config   Pfad zur Konfigurationsdatei (JS, CJS, MJS, JSON)
  -h, --help     Zeigt diese Hilfe an
  -v, --version  Zeigt die Paketversion an

Umgebungsvariablen:
  MAKO_ROUTER_CONFIG     Alternativer Pfad zur Konfiguration
  LOG_LEVEL              Loglevel (error|warn|info|debug)
  WILLI_MAKO_TOKEN       Token für Willi-Mako-Integration
`; // eslint-disable-line max-len
  // eslint-disable-next-line no-console
  console.log(helpText);
}

function fileExists(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch (error) {
    return false;
  }
}

function resolveConfigPath(providedPath) {
  if (providedPath) {
    const absolute = path.isAbsolute(providedPath)
      ? providedPath
      : path.join(process.cwd(), providedPath);
    if (!fileExists(absolute)) {
      throw new Error(`Konfigurationsdatei nicht gefunden: ${absolute}`);
    }
    return absolute;
  }

  for (const name of DEFAULT_CONFIG_NAMES) {
    const candidate = path.join(process.cwd(), name);
    if (fileExists(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    "Keine Konfigurationsdatei gefunden. Bitte --config angeben oder MAKO_ROUTER_CONFIG setzen."
  );
}

async function loadConfig(configPath) {
  const ext = path.extname(configPath).toLowerCase();
  let configModule;

  if (ext === ".mjs" || ext === ".ts") {
    configModule = await import(pathToFileURL(configPath).href);
  } else {
    configModule = require(configPath); // eslint-disable-line global-require, import/no-dynamic-require
  }

  let config = configModule && configModule.default ? configModule.default : configModule;
  if (typeof config === "function") {
    config = await config({ env: process.env });
  }

  if (!config || typeof config !== "object") {
    throw new Error("Konfiguration muss ein Objekt oder eine Funktion liefern.");
  }

  return config;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    return;
  }

  if (args.version) {
    // eslint-disable-next-line no-console
    console.log(pkg.version);
    return;
  }

  const configPath = resolveConfigPath(args.config);
  const routerConfig = await loadConfig(configPath);

  const router = new MessageRouter(routerConfig);
  const shutdownSignals = ["SIGINT", "SIGTERM"];
  let shuttingDown = false;

  const shutdown = async (signal) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    router.logger?.info?.("Beende Router", { signal });
    try {
      await router.stop();
      // eslint-disable-next-line no-console
      console.log("Router gestoppt");
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error("Fehler beim Stoppen", error);
      process.exitCode = 1;
    } finally {
      process.exit();
    }
  };

  shutdownSignals.forEach((signal) => {
    process.once(signal, () => {
      shutdown(signal).catch((error) => {
        // eslint-disable-next-line no-console
        console.error("Shutdown fehlgeschlagen", error);
        process.exit(1);
      });
    });
  });

  router.on("routed", ({ messageId, target }) => {
    // eslint-disable-next-line no-console
    console.log(`Weitergeleitet: ${messageId} → ${target.name ?? target.queue ?? target.topic ?? "unbekannt"}`);
  });

  router.on("failed", ({ messageId, error, stage, attempt }) => {
    // eslint-disable-next-line no-console
    console.warn(
      `Fehler (${stage}) bei ${messageId}: ${error?.message ?? error}. Versuch #${attempt}`
    );
  });

  // eslint-disable-next-line no-console
  console.log(`Konfiguration geladen: ${configPath}`);

  try {
    await router.start();
    // eslint-disable-next-line no-console
    console.log("mako-message-router aktiv");
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error("Router konnte nicht gestartet werden", error);
    process.exit(1);
  }
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("Unerwarteter Fehler", error);
  process.exit(1);
});
