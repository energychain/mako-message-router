# mako-message-router

Intelligentes Routing basierend auf EDIFACT-Nachrichten (edi@energy) für wiederverwendbare Marktkommunikations-Workflows in der deutschen Energiewirtschaft.

> Maintainer: [STROMDAO GmbH](https://stromdao.de)

## Überblick

- Regelbasierter Dispatcher für Prüfidentifikatoren, Marktrollen und Prozesse
- Queue-Integration für RabbitMQ und Apache Kafka inklusive Dead-Letter-Management
- Automatische EDIFACT→JSON-Transformation über `edifact-to-json-transformer`
- Exponentielles Backoff-Retry mit Jitter gegen Lastspitzen
- Optionale Willi-Mako-Anbindung zur Kontextanreicherung (Intent, Prozesswissen)


## Architektur im Überblick

- **Ingestion**: Ein Queue-Adapter liest EDIFACT-Payloads (z. B. UTILMD, MSCONS) aus einer Eingangsqueue.
- **Transformation**: Nachrichten werden in JSON transformiert und mit Metadaten versehen.
- **Regelwerk**: Frei definierbare Bedingungen bestimmen Zielsysteme (Queues, Topics, Services).
- **Distribution**: Weiterleitungen erfolgen über Producer-Adapter; nach Fehlversuchen werden Dead-Letter-Ziele bedient.
- **Optional**: Willi-Mako liefert Kontextwissen für komplexe Routing-Entscheidungen.

## Voraussetzungen

- Node.js >= 18 (nutzt `fetch`, `timers/promises`)
- Netzwerkzugriff auf die konfigurierten Broker (RabbitMQ/Kafka)
- EDIFACT-Dialekte, die vom Paket `edifact-to-json-transformer` unterstützt werden
- Optional: gültiges Token für die Willi-Mako-Plattform (`willi-mako-client`)

## Installation

```bash
# Sobald im npm-Registry veröffentlicht
yarn add mako-message-router

# Bis dahin lokal oder via Git-URL installieren
yarn add git+https://github.com/energychain/mako-message-router.git

# Runtime-Abhängigkeiten (peer dependencies)
yarn add edifact-to-json-transformer amqplib kafkajs

# Optional: Willi-Mako-Anbindung
yarn add willi-mako-client
```

> Alternativ zu `yarn` können `npm` oder `pnpm` verwendet werden.


## Schnellstart

1. **Broker vorbereiten**: Queues/Topics für Eingänge, Ziele und Dead-Letter einrichten (`edifact.inbound`, `nb.utilmd`, `mscons.measurements`, `edifact.dead`).
2. **Konfiguration anlegen**: Routingregeln, Retry-Strategie und Dead-Letter-Ziel in einer eigenen Datei definieren (siehe Beispiel oder `examples/basic-router.js`).
3. **Router starten**: Node-Skript ausführen (`node examples/basic-router.js`).
4. **Monitoring**: Events `routed` und `failed` abonnieren, `LOG_LEVEL=debug` zum Troubleshooting setzen.

```javascript
const { MessageRouter } = require("mako-message-router");
const routerConfig = require("./router.config");

const router = new MessageRouter(routerConfig)
  .on("routed", (payload) => console.log("Weitergeleitet", payload))
  .on("failed", (payload) => console.warn("Fehler", payload));

router.start().catch((error) => {
  console.error("Router-Absturz", error);
  process.exit(1);
});
```

## Konfigurationsdatei (Beispiel)

Eine Konfigurationsdatei exportiert entweder ein Objekt oder eine (optionale asynchrone) Funktion, die das Konfigurationsobjekt zurückgibt. Standardname ist `router.config.js`.

```javascript
// router.config.js
module.exports = async ({ env }) => ({
  routerId: env.ROUTER_ID ?? "mako-router",
  source: {
    type: "rabbitmq",
    url: env.RABBITMQ_URI ?? "amqp://guest:guest@localhost:5672",
    queue: env.EDIFACT_INBOUND_QUEUE ?? "edifact.inbound",
    prefetch: 10
  },
  producers: [
    {
      name: "rabbit-out",
      type: "rabbitmq",
      url: env.RABBITMQ_URI ?? "amqp://guest:guest@localhost:5672",
      queue: env.UTILITY_OUT_QUEUE ?? "nb.utilmd"
    },
    {
      name: "kafka",
      type: "kafka",
      brokers: (env.KAFKA_BROKERS ?? "localhost:9092").split(","),
      topic: env.MSCONS_TOPIC ?? "mscons.measurements"
    }
  ],
  deadLetter: {
    adapter: {
      type: "rabbitmq",
      url: env.RABBITMQ_URI ?? "amqp://guest:guest@localhost:5672",
      queue: env.DEAD_LETTER_QUEUE ?? "edifact.dead"
    },
    destination: env.DEAD_LETTER_QUEUE ?? "edifact.dead"
  },
  retry: {
    maxAttempts: Number(env.RETRY_MAX_ATTEMPTS ?? 5),
    baseDelayMs: Number(env.RETRY_BASE_DELAY ?? 2000),
    maxDelayMs: Number(env.RETRY_MAX_DELAY ?? 60000),
    jitter: Number(env.RETRY_JITTER ?? 0.2)
  },
  mako: {
    enabled: env.WILLI_MAKO_ENABLED !== "false",
    clientOptions: env.WILLI_MAKO_TOKEN ? { token: env.WILLI_MAKO_TOKEN } : undefined,
    sessionId: env.WILLI_MAKO_SESSION_ID
  },
  rules: [
    {
      name: "UTILMD an Netzbetreiber",
      conditions: [
        { path: "parsed.header.messageType", equals: "UTILMD" },
        { path: "parsed.participants.receiver.marketRole", equals: "NB" }
      ],
      target: {
        producer: "rabbit-out",
        queue: env.UTILITY_OUT_QUEUE ?? "nb.utilmd",
        forwardFormat: "json"
      }
    },
    {
      name: "MSCONS Messwerte",
      conditions: [{ path: "parsed.header.messageType", equals: "MSCONS" }],
      target: {
        producer: "kafka",
        topic: env.MSCONS_TOPIC ?? "mscons.measurements",
        forwardFormat: "json"
      }
    }
  ]
});
```

## Konfiguration

### 1. Eingangsadapter (`source`)

- RabbitMQ (`type: "rabbitmq"`): benötigt `url` und `queue`, optional `prefetch`, `inputEncoding`.
- Kafka (`type: "kafka"`): benötigt `brokers` und `topic`, optional `groupId`, `mode` (`consumer`, `producer`, `duplex`).
- Der Adapter fungiert als Consumer; Verbindungsfehler werden beim Start geworfen.

### 2. Zieladapter (`producers`)

- Array aus Producer-Konfigurationen mit eindeutiger `name`-Eigenschaft.
- Unterstützt RabbitMQ (Queues) und Kafka (Topics). RabbitMQ-Queues können bei Bedarf assertiert werden.

### 3. Regelwerk (`rules`)

- Jede Regel hat `name`, optionale `conditions` und einen `target`-Block.
- Kontext für Bedingungen: `parsed` (EDIFACT→JSON), `metadata` (Message-ID, Versuche), `makoContext` (sofern aktiv), `raw` (EDIFACT-String).
- Operatoren: `equals`, `notEquals`, `oneOf`, `matches`, `exists`, `predicate` (eigene Funktion).

```javascript
{
  name: "Lieferantenwechsel",
  conditions: [
    { path: "parsed.header.messageType", equals: "UTILMD" },
    { path: "parsed.business.process", oneOf: ["E02", "E03"] }
  ],
  target: {
    producer: "rabbit-out",
    queue: "wechsel.pruefung",
    forwardFormat: "json"
  }
}
```

### 4. Retry-Strategie (`retry`)

- `maxAttempts` (Default 5): Anzahl der Versuche inkl. Erstverarbeitung.
- `baseDelayMs` (Default 2000): Basiswert für exponentielles Backoff.
- `maxDelayMs` (Default 60000): Obergrenze der Wartezeit.
- `jitter` (Default 0.2): Zufallsanteil zur Entzerrung.

### 5. Dead-Letter (`deadLetter`)

- Besteht aus Adapter (`adapter`) und Ziel (`destination`).
- Nachrichten enthalten Fehlerdetails (`stage`, Stacktrace, `x-last-error`).
- Fehlkonfigurationen oder nicht erreichbare Retries landen ebenfalls im Dead-Letter.

### 6. Willi-Mako (`mako`)

- `enabled` (Default true) deaktiviert/aktiviert die Integration.
- `clientOptions` werden an den `WilliMakoClient`-Konstruktor übergeben, z. B. `{ token: process.env.WILLI_MAKO_TOKEN }`.
- `sessionId` erlaubt das Wiederverwenden bestehender Sessions.
- Routing funktioniert auch ohne Willi-Mako; Fehler werden geloggt, blockieren aber nicht.

### 7. Logging & Events

- Loglevel via `LOG_LEVEL` oder `options.logLevel` (error, warn, info, debug).
- Events:
  - `routed`: `{ messageId, target, metadata }`
  - `failed`: `{ messageId, error, stage, attempt }`
- Listener ermöglichen Integrationen in Observability- oder Alerting-Systeme.

### 8. Empfohlene Umgebungsvariablen

- `RABBITMQ_URI`: Verbindung zur RabbitMQ-Instanz
- `EDIFACT_INBOUND_QUEUE`: Name der Eingangsqueue
- `UTILITY_OUT_QUEUE`: Zielqueue für UTILMD-Routen
- `KAFKA_BROKERS`: Kommagetrennte Liste (`host:port`)
- `MSCONS_TOPIC`: Zieltopic für MSCONS-Routen
- `DEAD_LETTER_QUEUE`: Queue für Dead-Letter-Nachrichten
- `RETRY_MAX_ATTEMPTS`, `RETRY_BASE_DELAY`, `RETRY_MAX_DELAY`, `RETRY_JITTER`: Feintuning der Retry-Strategie
- `WILLI_MAKO_TOKEN`, `WILLI_MAKO_SESSION_ID`, `WILLI_MAKO_ENABLED`: Steuerung der Willi-Mako-Integration

## Microservice-Betrieb (CLI & Docker)

### CLI via `npx`

- Ohne lokale Installation: `npx mako-message-router --config ./router.config.js`
- Alternativ: `MAKO_ROUTER_CONFIG=./router.config.js npx mako-message-router`
- `--help` zeigt alle Optionen inkl. Loglevel und Umgebungsvariablen
- Der Prozess fängt `SIGINT`/`SIGTERM` ab und führt `router.stop()` aus, sodass Verbindungen sauber geschlossen werden

### Betrieb als Docker-Container

```dockerfile
FROM node:20-alpine
WORKDIR /srv/router

# Konfigurationsdatei einspielen
COPY router.config.js ./router.config.js

# Laufzeitabhängigkeiten installieren
RUN npm install -g mako-message-router \
  edifact-to-json-transformer \
  amqplib \
  kafkajs

ENV NODE_ENV=production \
    LOG_LEVEL=info

CMD ["mako-message-router", "--config", "./router.config.js"]
```

- Konfiguration und Secrets (z. B. `WILLI_MAKO_TOKEN`) bevorzugt per `docker run -e` oder Secrets-Manager setzen
- Für Kubernetes/Compose kann die Konfigurationsdatei als ConfigMap/Volume eingebunden werden
- Health-Checks können auf Queue-Verfügbarkeit prüfen oder Logs per Promtail/Fluent Bit einsammeln

## Beispiele

- `examples/basic-router.js`: Vollständiges Setup mit RabbitMQ-Source, RabbitMQ- und Kafka-Zielen sowie Dead-Letter-Konfiguration.

## Fachlicher Kontext & Ressourcen

- **Willi-Mako-Plattform**: Liefert validiertes Fachwissen zu Prozessen wie **GPKE** (Geschäftsprozesse zur Kundenbelieferung mit Elektrizität), **WiM** (Wechselprozesse im Messwesen), **GeLi Gas** (Lieferantenwechsel Gas) und **MPES** (Mehr-/Mindermengen). Über den Client (`resolveContext`, `semanticSearch`, `generateReasoning`) kann das Regelwerk mit aktuellem Markt-Know-how angereichert werden. Ein Einstieg in die Plattform ist direkt über [https://stromhaltig.de/app/](https://stromhaltig.de/app/) möglich.
- **Lieferantenwechsel**: Bei UTILMD E02/E03 sind Stammdaten, Wechseltermine und Marktrollen kritisch. Willi Mako hilft beim Ableiten der korrekten Zielqueues/Topics, wenn neue Prüfidentifikatoren vom BDEW veröffentlicht werden.
- **Messwesen & MSCONS**: WiM-Prozesse verlangen differenzierte Messlokationszuordnung und Plausibilisierung von Messwerten. Die Plattform bietet Checklisten für Plausibilitätsprüfungen und Eskalationspfade (z. B. Störungsmanagement).
- **Rückgriff auf stromhaltig.de**: Entwickler:innen ohne Marktkommunikationshintergrund finden Einsteigerinformationen, Glossar und aktuelle Regularien unter [https://stromhaltig.de/](https://stromhaltig.de/).
- **Regulatorik im Blick**: Nutzen Sie Willi Mako, um neue Festlegungen (z. B. BK6/BK7) oder EEG-/EnWG-Anforderungen zu identifizieren und in Routingregeln zu spiegeln.

## Grenzen & Annahmen

- EDIFACT-Parsing hängt vom externen Paket `edifact-to-json-transformer` ab; unbekannte Nachrichten führen zu Retries/Dead-Letter.
- Kafka bietet kein explizites `nack`. Ein Fehler im Handler verursacht automatisch einen Retry.
- Der Router speichert keine Zustände (z. B. Offsets). Persistenz muss durch Broker- oder Infrastrukturmechanismen erfolgen.
- Netzwerk- oder Broker-Ausfälle müssen extern abgefangen werden (Reconnect-Strategien, High Availability).

## Qualitätssicherung & Betrieb

- Regelwerke sollten über Unit-/Integrationstests mit repräsentativen EDIFACT-Payloads abgedeckt werden.
- Empfohlen: Metriken (Prometheus, OpenTelemetry) für Durchsatz, Retry-Quote, Dead-Letter-Anteil.
- Für produktive Deployments Prozess-Manager (systemd, PM2, Kubernetes) verwenden.

## Lizenz

MIT License — siehe `LICENSE`.
