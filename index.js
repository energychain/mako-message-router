"use strict";

/**
 * Intelligentes Routing für EDIFACT-Nachrichten mit Queue-Integration
 * und Willi-Mako-Unterstützung.
 */

const { EventEmitter } = require("node:events");
const { setTimeout: delay } = require("node:timers/promises");
const { randomUUID } = require("node:crypto");

function optionalRequire(name) {
	try {
		return require(name);
	} catch (err) {
		if (err.code === "MODULE_NOT_FOUND") {
			return null;
		}
		throw err;
	}
}

const edifactTransformerPkg = optionalRequire("edifact-to-json-transformer");
const williMakoClientPkg = optionalRequire("willi-mako-client");
const amqplib = optionalRequire("amqplib");
const kafkajs = optionalRequire("kafkajs");

/**
 * @typedef {Object} RuleCondition
 * @property {string} path Pfad auf dem Kontextobjekt (dot notation)
 * @property {string|number|boolean} [equals] Erwarteter exakter Wert
 * @property {string|number|boolean} [notEquals] Unerlaubter Wert
 * @property {Array<string|number|boolean>} [oneOf] Zulässige Werte
 * @property {string} [matches] Regulärer Ausdruck
 * @property {boolean} [exists] Erwartete Existenz des Wertes
 * @property {(value:any, context:any) => boolean} [predicate] Individuelle Prüfung
 */

/**
 * @typedef {Object} RuleTarget
 * @property {string} [name] Anzeigename der Route
 * @property {string} [producer] Konfigurierter Producer-Name
 * @property {string} [queue] Zielqueue (RabbitMQ)
 * @property {string} [topic] Zieltoppic (Kafka)
 * @property {string} [destination] Generisches Ziel, fällt auf queue/topic zurück
 * @property {"json"|"edifact"|"buffer"} [forwardFormat="json"] Ausgabeformat
 */

/**
 * @typedef {Object} RuleDefinition
 * @property {string} name Name der Route
 * @property {RuleCondition[]} [conditions] Bedingungen für die Route
 * @property {RuleTarget} target Definition des Routings
 */

/**
 * @typedef {Object} RabbitMqConfig
 * @property {"rabbitmq"} type
 * @property {string} url Verbindungs-URL
 * @property {string} [queue] Queue-Name
 * @property {number} [prefetch]
 * @property {Object} [assertQueueOptions]
 * @property {string} [inputEncoding="utf-8"]
 * @property {string} [outputEncoding="utf-8"]
 * @property {"json"|"edifact"|"buffer"} [outputFormat="json"]
 */

/**
 * @typedef {Object} KafkaConfig
 * @property {"kafka"} type
 * @property {string[]} brokers Brokerliste
 * @property {string} [topic]
 * @property {string} [clientId]
 * @property {string} [groupId]
 * @property {"consumer"|"producer"|"duplex"} [mode="duplex"]
 * @property {string} [inputEncoding="utf-8"]
 * @property {"json"|"edifact"|"buffer"} [outputFormat="json"]
 */

/**
 * @typedef {Object} RetryOptions
 * @property {number} [maxAttempts=5]
 * @property {number} [baseDelayMs=2000]
 * @property {number} [maxDelayMs=60000]
 * @property {number} [jitter=0.2]
 */

/**
 * @typedef {Object} DeadLetterOptions
 * @property {RabbitMqConfig|KafkaConfig} adapter Adapter für Dead-Letter
 * @property {string} destination Queue oder Topic des Dead-Letter-Ziels
 */

/**
 * @typedef {Object} MakoOptions
 * @property {boolean} [enabled=true]
 * @property {any} [client] Bereits initialisierter Willi-Mako-Client
 * @property {Object} [clientOptions] Optionen für den Willi-Mako-Client-Konstruktor
 * @property {string} [sessionId] Wiederzuverwendende Session-ID
 */

/**
 * @typedef {Object} RouterOptions
 * @property {string} [routerId] Fester Identifier des Routers
 * @property {RabbitMqConfig|KafkaConfig} source Queue-Adapter für Eingänge
 * @property {Array<(RabbitMqConfig|KafkaConfig)&{name:string}>} [producers] Konfigurierte Zieladapter
 * @property {DeadLetterOptions} [deadLetter] Konfiguration für Dead-Letter
 * @property {RetryOptions} [retry]
 * @property {RuleDefinition[]} [rules]
 * @property {MakoOptions} [mako]
 * @property {Object} [transformer] Optionen für den EDIFACT-Transformer
 * @property {"error"|"warn"|"info"|"debug"} [logLevel]
 */

function createEdifactTransformer(options = {}) {
	if (!edifactTransformerPkg) {
		throw new Error(
			"edifact-to-json-transformer ist nicht installiert. Bitte `npm install edifact-to-json-transformer` ausführen."
		);
	}

	if (typeof edifactTransformerPkg === "function") {
		return {
			transform: (message) => edifactTransformerPkg(message, options)
		};
	}

	if (typeof edifactTransformerPkg.transform === "function") {
		return {
			transform: (message) => edifactTransformerPkg.transform(message, options)
		};
	}

	if (
		edifactTransformerPkg.default &&
		typeof edifactTransformerPkg.default.transform === "function"
	) {
		return {
			transform: (message) => edifactTransformerPkg.default.transform(message, options)
		};
	}

	throw new Error(
		"edifact-to-json-transformer bietet keine kompatible Transformationsfunktion."
	);
}

/**
 * Einfacher stdout-Logger mit Loglevel-Steuerung.
 */
class Logger {
	constructor(namespace, level = process.env.LOG_LEVEL || "info") {
		this.namespace = namespace;
		this.level = level;
		this.levels = new Map([
			["error", 0],
			["warn", 1],
			["info", 2],
			["debug", 3]
		]);
	}

	shouldLog(level) {
		return (
			this.levels.get(level) <=
			(this.levels.get(this.level) ?? this.levels.get("info"))
		);
	}

	format(level, message, meta) {
		const timestamp = new Date().toISOString();
		if (meta === undefined) {
			return `[${timestamp}] [${this.namespace}] [${level.toUpperCase()}] ${message}`;
		}
		return `[${timestamp}] [${this.namespace}] [${level.toUpperCase()}] ${message} ${JSON.stringify(meta)}`;
	}

	error(message, meta) {
		if (this.shouldLog("error")) {
			// eslint-disable-next-line no-console
			console.error(this.format("error", message, meta));
		}
	}

	warn(message, meta) {
		if (this.shouldLog("warn")) {
			// eslint-disable-next-line no-console
			console.warn(this.format("warn", message, meta));
		}
	}

	info(message, meta) {
		if (this.shouldLog("info")) {
			// eslint-disable-next-line no-console
			console.log(this.format("info", message, meta));
		}
	}

	debug(message, meta) {
		if (this.shouldLog("debug")) {
			// eslint-disable-next-line no-console
			console.log(this.format("debug", message, meta));
		}
	}
}

/**
 * Regelwerk zur Bestimmung des Routing-Ziels.
 */
class RuleEngine {
	constructor(rules = []) {
		this.rules = rules;
	}

	evaluate(context) {
		for (const rule of this.rules) {
			if (this.matchesRule(rule, context)) {
					const targetName = rule.target?.name ?? rule.name;
					return {
						...rule.target,
						name: targetName
					};
			}
		}
		return null;
	}

	matchesRule(rule, context) {
		if (!rule.conditions || rule.conditions.length === 0) {
			return true;
		}

		return rule.conditions.every((condition) => {
			const leftValue = this.resolvePath(context, condition.path);
			if (condition.equals !== undefined) {
				return leftValue === condition.equals;
			}
			if (condition.oneOf) {
				return condition.oneOf.includes(leftValue);
			}
			if (condition.matches) {
				const regex = new RegExp(condition.matches);
				return regex.test(String(leftValue ?? ""));
			}
			if (condition.notEquals !== undefined) {
				return leftValue !== condition.notEquals;
			}
			if (condition.exists === true) {
				return leftValue !== undefined && leftValue !== null;
			}
			if (condition.exists === false) {
				return leftValue === undefined || leftValue === null;
			}
			if (typeof condition.predicate === "function") {
				return Boolean(condition.predicate(leftValue, context));
			}
			return false;
		});
	}

	resolvePath(input, path) {
		if (!path) {
			return undefined;
		}
		return path.split(".").reduce((acc, segment) => {
			if (acc === undefined || acc === null) {
				return undefined;
			}
			return acc[segment];
		}, input);
	}
}

/**
 * Exponentielle Retry-Strategie inkl. Jitter.
 */
class RetryStrategy {
	constructor(options = {}) {
		this.maxAttempts = options.maxAttempts ?? 5;
		this.baseDelayMs = options.baseDelayMs ?? 2_000;
		this.maxDelayMs = options.maxDelayMs ?? 60_000;
		this.jitter = options.jitter ?? 0.2;
	}

	nextDelay(attempt) {
		const exponential = this.baseDelayMs * 2 ** (attempt - 1);
		const capped = Math.min(exponential, this.maxDelayMs);
		const jitterFactor = 1 + (Math.random() * 2 - 1) * this.jitter;
		return Math.round(capped * jitterFactor);
	}

	shouldRetry(attempt) {
		return attempt < this.maxAttempts;
	}
}

/**
 * Bereitet Nachrichten für Dead-Letter-Ziele auf.
 */
class DeadLetterPublisher {
	constructor(adapter, destination) {
		this.adapter = adapter;
		this.destination = destination;
	}

	async publish(payload) {
		if (!this.adapter) {
			throw new Error("Kein Dead-Letter-Adapter konfiguriert.");
		}
		if (!this.destination) {
			throw new Error("Kein Dead-Letter-Ziel konfiguriert.");
		}
		await this.adapter.send(this.destination, payload, {
			headers: {
				"x-dead-letter": "true",
				"x-dead-letter-timestamp": new Date().toISOString()
			},
			persistent: true
		});
	}
}

/**
 * Abstrakter Basisadapter für Queue-Integrationen.
 */
class BaseQueueAdapter {
	constructor(name) {
		this.name = name;
		this.logger = new Logger(`queue:${name}`);
	}

	// eslint-disable-next-line class-methods-use-this
	async init() {}

	// eslint-disable-next-line class-methods-use-this
	async close() {}
}

/**
 * RabbitMQ-Integration (Consumer & Producer).
 */
class RabbitMQAdapter extends BaseQueueAdapter {
	constructor(name, config) {
		super(name);
		if (!amqplib) {
			throw new Error("amqplib ist nicht installiert. Bitte `npm install amqplib` ausführen.");
		}
		this.config = config;
		this.connection = null;
		this.channel = null;
	}

	async init() {
		this.connection = await amqplib.connect(this.config.url);
		this.channel = await this.connection.createChannel();
		if (this.config.prefetch) {
			await this.channel.prefetch(this.config.prefetch);
		}
		if (this.config.assertQueue !== false && this.config.queue) {
			await this.channel.assertQueue(this.config.queue, this.config.assertQueueOptions ?? { durable: true });
		}
		this.logger.info("RabbitMQ-Verbindung hergestellt", {
			url: this.config.url,
			queue: this.config.queue
		});
	}

	async consume(handler) {
		if (!this.config.queue) {
			throw new Error("RabbitMQ-Adapter: Keine Eingangsqueue definiert.");
		}
		await this.channel.consume(this.config.queue, async (message) => {
			if (!message) {
				return;
			}

			const attempt =
				(message.properties?.headers?.["x-retry-count"] ?? 0) || 0;
			const ack = () => this.channel.ack(message);
			const nack = (requeue = false) => this.channel.nack(message, false, requeue);
			const body = message.content.toString(this.config.inputEncoding ?? "utf-8");

			await handler({
				attempt,
				body,
				raw: message,
				headers: message.properties?.headers ?? {},
				properties: message.properties,
				ack,
				nack
			});
		});
	}

	async send(destination, payload, options = {}) {
			const format = options.serializeAs ?? this.config.outputFormat ?? "json";
			const buffer = this.serializePayload(payload, format);
		this.channel.sendToQueue(destination, buffer, {
			persistent: true,
			headers: options.headers,
				contentType: options.contentType ?? (format === "edifact" ? "text/plain" : "application/json"),
			messageId: options.messageId ?? payload?.messageId ?? randomUUID(),
			timestamp: Date.now()
		});
	}

	serializePayload(payload, format) {
		if (format === "edifact" && typeof payload.raw === "string") {
			return Buffer.from(payload.raw, this.config.outputEncoding ?? "utf-8");
		}
		if (format === "buffer" && Buffer.isBuffer(payload)) {
			return payload;
		}
		return Buffer.from(JSON.stringify(payload));
	}

	async close() {
		await this.channel?.close();
		await this.connection?.close();
		this.logger.info("RabbitMQ-Verbindung geschlossen");
	}
}

/**
 * Apache Kafka-Integration (Consumer & Producer).
 */
class KafkaAdapter extends BaseQueueAdapter {
	constructor(name, config) {
		super(name);
		if (!kafkajs) {
			throw new Error("kafkajs ist nicht installiert. Bitte `npm install kafkajs` ausführen.");
		}
		const { Kafka } = kafkajs;
		this.config = config;
		this.kafka = new Kafka({
			clientId: config.clientId ?? `mako-router-${name}`,
			brokers: config.brokers
		});
		this.consumer = null;
		this.producer = null;
	}

	async init() {
		if (this.config.mode !== "producer") {
			this.consumer = this.kafka.consumer({ groupId: this.config.groupId ?? `mako-router-${this.name}` });
			await this.consumer.connect();
			await this.consumer.subscribe({ topic: this.config.topic, fromBeginning: false });
		}
		if (this.config.mode !== "consumer") {
			this.producer = this.kafka.producer();
			await this.producer.connect();
		}
		this.logger.info("Kafka-Adapter initialisiert", {
			topic: this.config.topic,
			mode: this.config.mode ?? "duplex"
		});
	}

	async consume(handler) {
		if (!this.consumer) {
			throw new Error("Kafka-Adapter: Consumer ist nicht aktiv.");
		}

		await this.consumer.run({
			eachMessage: async ({ message, partition, topic }) => {
				const headers = Object.fromEntries(
					Object.entries(message.headers ?? {}).map(([key, value]) => [key, value?.toString()])
				);
				const attempt = Number(headers["x-retry-count"] ?? 0);
				const body = (message.value ?? Buffer.from("")).toString(
					this.config.inputEncoding ?? "utf-8"
				);

				const ack = async () => {
					// kafkajs committet automatisch nach erfolgreichem Handlerlauf.
				};

				const nack = async () => {
					throw new Error("Kafka-Adapter unterstützt nack nicht direkt. Handler muss Fehler werfen.");
				};

				await handler({
					attempt,
					body,
					raw: message,
					topic,
					partition,
					headers,
					properties: {
						offset: message.offset,
						timestamp: message.timestamp
					},
					ack,
					nack
				});
			}
		});
	}

	async send(destination, payload, options = {}) {
		if (!this.producer) {
			throw new Error("Kafka-Adapter: Producer ist nicht aktiv.");
		}
		const topic = options.topic ?? destination ?? this.config.topic;
		const value = this.serializePayload(payload, options.serializeAs ?? this.config.outputFormat ?? "json");

		await this.producer.send({
			topic,
			messages: [
				{
					key: options.key ?? payload?.messageId ?? randomUUID(),
					value,
					headers: options.headers
				}
			]
		});
	}

	serializePayload(payload, format) {
		if (format === "edifact" && typeof payload.raw === "string") {
			return payload.raw;
		}
		if (format === "buffer" && Buffer.isBuffer(payload)) {
			return payload;
		}
		return Buffer.from(JSON.stringify(payload));
	}

	async close() {
		await this.consumer?.disconnect();
		await this.producer?.disconnect();
		this.logger.info("Kafka-Adapter geschlossen");
	}
}

/**
 * Koordiniert Source-Adapter und Producer.
 */
class QueueManager {
	constructor(config) {
		this.source = this.instantiateAdapter("source", config.source);
		this.producers = new Map();

		for (const producerConfig of config.producers ?? []) {
			const adapter = this.instantiateAdapter(`producer:${producerConfig.name}`, producerConfig);
			this.producers.set(producerConfig.name, adapter);
		}

		this.deadLetterAdapter = config.deadLetter
			? this.instantiateAdapter("deadLetter", config.deadLetter)
			: null;
	}

	instantiateAdapter(name, config = {}) {
		if (!config || !config.type) {
			throw new Error(`Adapter-Konfiguration fuer ${name} fehlt oder ist unvollstaendig.`);
		}

		if (config.type === "rabbitmq") {
			return new RabbitMQAdapter(name, config);
		}
		if (config.type === "kafka") {
			return new KafkaAdapter(name, config);
		}
		throw new Error(`Unbekannter Adaptertyp: ${config.type}`);
	}

	async init() {
		await this.source.init();
		for (const adapter of this.producers.values()) {
			await adapter.init();
		}
		if (this.deadLetterAdapter) {
			await this.deadLetterAdapter.init();
		}
	}

	getProducer(name) {
		if (name === "source" || (!name && this.producers.size === 0)) {
			return this.source;
		}
		if (!name) {
			throw new Error("Es wurde kein Producer-Name angegeben.");
		}
		const adapter = this.producers.get(name);
		if (!adapter) {
			throw new Error(`Producer '${name}' ist nicht registriert.`);
		}
		return adapter;
	}

	createDeadLetterPublisher(destination) {
		if (!this.deadLetterAdapter) {
			return null;
		}
		return new DeadLetterPublisher(this.deadLetterAdapter, destination);
	}

	async close() {
		await this.source.close();
		for (const adapter of this.producers.values()) {
			await adapter.close();
		}
		await this.deadLetterAdapter?.close();
	}
}

/**
 * Optionaler Anschluss an die Willi-Mako-Plattform.
 */
class MakoIntegration {
	constructor(options = {}) {
		this.enabled = options.enabled !== false;
		if (!this.enabled) {
			this.client = null;
			return;
		}

		if (options.client) {
			this.client = options.client;
				this.logger = new Logger("mako");
			return;
		}

		if (!williMakoClientPkg) {
			throw new Error(
				"willi-mako-client ist nicht installiert. Bitte `npm install willi-mako-client` ausführen oder die Integration deaktivieren."
			);
		}

		const ClientCtor = williMakoClientPkg.WilliMakoClient ?? williMakoClientPkg.default;
		if (!ClientCtor) {
			throw new Error("Willi-Mako-Client konnte nicht initialisiert werden.");
		}

		this.client = new ClientCtor(options.clientOptions ?? {});
		this.sessionId = options.sessionId;
		this.logger = new Logger("mako");
	}

	async enrichMessage({ parsed, raw }) {
		if (!this.client || typeof this.client.resolveContext !== "function") {
			return null;
		}

		const queryPayload = {
			query: `Routing-Kontext fuer ${parsed?.header?.messageType ?? "unbekannt"}`,
			metadata: {
				messageType: parsed?.header?.messageType,
				process: parsed?.header?.process,
				marketRoles: parsed?.participants,
				identifiers: parsed?.identifiers
			}
		};

		if (this.sessionId) {
			queryPayload.sessionId = this.sessionId;
		}

		try {
			const result = await this.client.resolveContext(queryPayload);
			return result?.data ?? result ?? null;
		} catch (error) {
			this.logger?.warn("Willi-Mako-Kontextabfrage fehlgeschlagen", {
				message: error.message
			});
			return null;
		}
	}
}

/**
 * Zentraler Router zum Verarbeiten und Verteilen von EDIFACT-Nachrichten.
 *
 * @extends EventEmitter
 * @fires MessageRouter#routed Wenn eine Nachricht erfolgreich weitergeleitet wurde
 * @fires MessageRouter#failed Bei Fehlern vor Retry oder Dead-Letter
 * @param {RouterOptions} options Konfiguration des Routers
 */
class MessageRouter extends EventEmitter {
	constructor(options) {
		super();
		if (!options) {
			throw new Error("MessageRouter erfordert Optionen.");
		}

		this.logger = new Logger("router", options.logLevel);
		this.transformer = createEdifactTransformer(options.transformer ?? {});
		this.queueManager = new QueueManager({
			source: options.source,
			producers: options.producers,
			deadLetter: options.deadLetter?.adapter
		});

		this.deadLetterPublisher = options.deadLetter?.destination
			? this.queueManager.createDeadLetterPublisher(options.deadLetter.destination)
			: null;

		this.ruleEngine = new RuleEngine(options.rules ?? []);
		this.retryStrategy = new RetryStrategy(options.retry ?? {});
		this.makoIntegration = new MakoIntegration(options.mako ?? {});
		this.routerId = options.routerId ?? randomUUID();
	}

	async start() {
		await this.queueManager.init();
		await this.queueManager.source.consume(async (message) => {
			await this.processMessage(message);
		});
		this.logger.info("Router gestartet", { routerId: this.routerId });
	}

	async processMessage(message) {
		const metadata = this.buildMetadata(message);
		this.logger.debug("Eingehende Nachricht", metadata);

		let parsed;
		try {
			parsed = await this.transformer.transform(message.body);
		} catch (error) {
			this.logger.error("EDIFACT-Parsing fehlgeschlagen", {
				error: error.message
			});
			await this.handleFailure({ message, metadata, error, stage: "transform" });
			return;
		}

		const makoContext = await this.makoIntegration.enrichMessage({ parsed, raw: message.body });
		const ruleContext = {
			metadata,
			parsed,
			makoContext,
			raw: message.body
		};

		const target = this.ruleEngine.evaluate(ruleContext);

		if (!target) {
			this.logger.warn("Keine passende Route gefunden", {
				messageId: metadata.messageId
			});
			await this.handleFailure({
				message,
				metadata,
				error: new Error("Keine Route gefunden"),
				stage: "routing"
			});
			return;
		}

		try {
			await this.forwardMessage({ message, metadata, parsed, makoContext, target });
			await message.ack();
			/**
			 * Erfolgreiche Weiterleitung
			 * @event MessageRouter#routed
			 * @type {{messageId:string,target:RuleTarget,metadata:Object}}
			 */
			this.emit("routed", {
				messageId: metadata.messageId,
				target,
				metadata
			});
		} catch (error) {
			this.logger.error("Weiterleitung fehlgeschlagen", {
				messageId: metadata.messageId,
				target,
				error: error.message
			});
			await this.handleFailure({ message, metadata, error, stage: "forward" });
		}
	}

	buildMetadata(message) {
		const attempt = Number(message.attempt ?? 0);
		const headers = message.headers ?? {};
		const messageId = headers["message-id"] ?? headers.messageId ?? randomUUID();
		return {
			messageId,
			attempt,
			receivedAt: new Date().toISOString(),
			routerId: this.routerId
		};
	}

	async forwardMessage({ message, metadata, parsed, makoContext, target }) {
		const producer = this.queueManager.getProducer(target.producer);
		const destination = target.queue ?? target.topic ?? target.destination;
		if (!destination) {
			throw new Error("Zielfeld (queue/topic) fehlt im Target.");
		}

		const envelope = {
			messageId: metadata.messageId,
			routerId: metadata.routerId,
			rawEdifact: message.body,
			parsed,
			makoContext,
			attempt: metadata.attempt,
			routedAt: new Date().toISOString(),
			target,
			source: {
				headers: message.headers,
				properties: message.properties
			}
		};

		const headers = {
			"x-router-id": this.routerId,
			"x-original-message-id": metadata.messageId,
			"x-route-name": target.name ?? target.queue ?? target.topic,
			"x-retry-count": metadata.attempt
		};

		await producer.send(destination, envelope, {
			headers,
			topic: target.topic,
			serializeAs: target.forwardFormat ?? "json"
		});
	}

	async handleFailure({ message, metadata, error, stage }) {
		const attempt = (metadata.attempt ?? 0) + 1;
		const shouldRetry = this.retryStrategy.shouldRetry(attempt);
		/**
		 * Fehler beim Verarbeiten einer Nachricht
		 * @event MessageRouter#failed
		 * @type {{messageId:string,error:Error,stage:string,attempt:number}}
		 */
		this.emit("failed", {
			messageId: metadata.messageId,
			error,
			stage,
			attempt
		});

		if (!shouldRetry) {
			await message.ack();
			await this.moveToDeadLetter({ message, metadata, error, stage });
			return;
		}

		const delayMs = this.retryStrategy.nextDelay(attempt);
		this.logger.warn("Retry geplant", {
			messageId: metadata.messageId,
			attempt,
			delayMs
		});

		await message.ack();
		await delay(delayMs);

		const producer = this.queueManager.getProducer("source");
		const retryDestination = producer?.config?.queue ?? producer?.config?.topic;
		if (!retryDestination) {
			this.logger.error("Retry nicht moeglich, da kein Ziel vorhanden ist", {
				messageId: metadata.messageId
			});
			await this.moveToDeadLetter({ message, metadata, error, stage });
			return;
		}

		const headers = {
			...(message.headers ?? {}),
			"x-retry-count": attempt,
			"x-last-error": error.message,
			"x-last-error-stage": stage
		};

		try {
			await producer.send(
				retryDestination,
				{
					messageId: metadata.messageId,
					raw: message.body,
					attempt,
					lastError: error.message
				},
				{
					headers,
					serializeAs: "edifact"
				}
			);
		} catch (retryError) {
			this.logger.error("Retry-Weiterleitung fehlgeschlagen", {
				messageId: metadata.messageId,
				error: retryError.message
			});
			await this.moveToDeadLetter({ message, metadata, error: retryError, stage: "retry" });
		}
	}

	async moveToDeadLetter({ message, metadata, error, stage }) {
		if (!this.deadLetterPublisher) {
			this.logger.error("Dead-Letter nicht verfuegbar", {
				messageId: metadata.messageId,
				error: error.message
			});
			return;
		}

		const payload = {
			messageId: metadata.messageId,
			routerId: metadata.routerId,
			rawEdifact: message.body,
			attempt: metadata.attempt,
			failedAt: new Date().toISOString(),
			error: {
				message: error.message,
				stack: error.stack,
				stage
			}
		};

		await this.deadLetterPublisher.publish(payload);
		this.logger.warn("Nachricht in Dead-Letter ueberfuehrt", {
			messageId: metadata.messageId
		});
	}

		async stop() {
			await this.queueManager.close();
			this.logger.info("Router gestoppt", { routerId: this.routerId });
		}
}

module.exports = {
	MessageRouter,
	RuleEngine,
	RetryStrategy,
	QueueManager,
	RabbitMQAdapter,
	KafkaAdapter,
	MakoIntegration,
	Logger
};

