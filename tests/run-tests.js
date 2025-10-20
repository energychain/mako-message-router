"use strict";

const assert = require("node:assert/strict");
const { RuleEngine, RetryStrategy, Logger } = require("../index.js");

function testRuleEngineMatchesFirstRule() {
  const engine = new RuleEngine([
    {
      name: "first",
      conditions: [{ path: "parsed.header.messageType", equals: "UTILMD" }],
      target: { producer: "a" }
    },
    {
      name: "second",
      conditions: [{ path: "parsed.header.messageType", equals: "MSCONS" }],
      target: { producer: "b" }
    }
  ]);

  const context = {
    parsed: {
      header: {
        messageType: "UTILMD"
      }
    }
  };

  const result = engine.evaluate(context);
  assert.ok(result, "Es sollte ein Routingziel gefunden werden");
  assert.equal(result.name, "first");
  assert.equal(result.producer, "a");
}

function testRuleEngineFallbackToNull() {
  const engine = new RuleEngine([
    {
      name: "only",
      conditions: [{ path: "parsed.header.messageType", equals: "UTILMD" }],
      target: { producer: "a" }
    }
  ]);

  const context = {
    parsed: {
      header: {
        messageType: "MSCONS"
      }
    }
  };

  const result = engine.evaluate(context);
  assert.equal(result, null);
}

function testRetryStrategyBackoffGrowth() {
  const retry = new RetryStrategy({ baseDelayMs: 100, maxDelayMs: 1_000, jitter: 0 });
  const first = retry.nextDelay(1);
  const second = retry.nextDelay(2);
  const third = retry.nextDelay(3);

  assert.equal(first, 100);
  assert.equal(second, 200);
  assert.equal(third, 400);
  assert.ok(retry.shouldRetry(1));
  assert.ok(!retry.shouldRetry(5), "Standardmäßig sind 5 Versuche erlaubt, der 6. sollte abgelehnt werden");
}

function testLoggerLevels() {
  const logger = new Logger("test", "warn");
  assert.ok(logger.shouldLog("error"));
  assert.ok(logger.shouldLog("warn"));
  assert.ok(!logger.shouldLog("info"));
}

function runAllTests() {
  const tests = [
    ["RuleEngine trifft erste passende Regel", testRuleEngineMatchesFirstRule],
    ["RuleEngine gibt null zurück, wenn keine Regel passt", testRuleEngineFallbackToNull],
    ["RetryStrategy erzeugt exponentielles Backoff", testRetryStrategyBackoffGrowth],
    ["Logger respektiert Loglevel", testLoggerLevels]
  ];

  for (const [name, fn] of tests) {
    try {
      fn();
      // eslint-disable-next-line no-console
      console.log(`✔ ${name}`);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(`✖ ${name}`);
      throw error;
    }
  }

  // eslint-disable-next-line no-console
  console.log("Alle Tests erfolgreich bestanden.");
}

runAllTests();
