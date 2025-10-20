"use strict";

const { MessageRouter } = require("../index");

const router = new MessageRouter({
  routerId: "mako-router-demo",
  source: {
    type: "rabbitmq",
    url: process.env.RABBITMQ_URI ?? "amqp://guest:guest@localhost:5672",
    queue: process.env.EDIFACT_INBOUND_QUEUE ?? "edifact.inbound",
    prefetch: 10
  },
  producers: [
    {
      name: "rabbit-out",
      type: "rabbitmq",
      url: process.env.RABBITMQ_URI ?? "amqp://guest:guest@localhost:5672",
      queue: process.env.UTILITY_OUT_QUEUE ?? "nb.utilmd"
    },
    {
      name: "kafka",
      type: "kafka",
      brokers: (process.env.KAFKA_BROKERS ?? "localhost:9092").split(","),
      topic: process.env.MSCONS_TOPIC ?? "mscons.measurements"
    }
  ],
  deadLetter: {
    adapter: {
      type: "rabbitmq",
      url: process.env.RABBITMQ_URI ?? "amqp://guest:guest@localhost:5672",
      queue: process.env.DEAD_LETTER_QUEUE ?? "edifact.dead"
    },
    destination: process.env.DEAD_LETTER_QUEUE ?? "edifact.dead"
  },
  retry: {
    maxAttempts: Number(process.env.RETRY_MAX_ATTEMPTS ?? 5),
    baseDelayMs: Number(process.env.RETRY_BASE_DELAY ?? 2000),
    maxDelayMs: Number(process.env.RETRY_MAX_DELAY ?? 60000),
    jitter: Number(process.env.RETRY_JITTER ?? 0.2)
  },
  mako: {
    enabled: process.env.WILLI_MAKO_ENABLED !== "false",
    clientOptions: process.env.WILLI_MAKO_TOKEN
      ? { token: process.env.WILLI_MAKO_TOKEN }
      : undefined,
    sessionId: process.env.WILLI_MAKO_SESSION_ID
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
        queue: process.env.UTILITY_OUT_QUEUE ?? "nb.utilmd",
        forwardFormat: "json"
      }
    },
    {
      name: "MSCONS Messwerte",
      conditions: [{ path: "parsed.header.messageType", equals: "MSCONS" }],
      target: {
        producer: "kafka",
        topic: process.env.MSCONS_TOPIC ?? "mscons.measurements",
        forwardFormat: "json"
      }
    }
  ]
})
  .on("routed", (payload) => {
    // Hilfreich für erste Smoke-Tests
    console.log("Weitergeleitet", payload.messageId, "→", payload.target.name);
  })
  .on("failed", (payload) => {
    console.warn("Verarbeitung fehlgeschlagen", payload.messageId, payload.error);
  });

router.start().catch((error) => {
  console.error("Router-Absturz", error);
  process.exit(1);
});
