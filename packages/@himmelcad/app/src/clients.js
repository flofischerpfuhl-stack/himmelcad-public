"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RegistrationClient = exports.IoClient = exports.DocumentClient = exports.ResidencyClient = exports.CanonicalProjectClient = void 0;
const canonicalProtocol_js_1 = require("./canonicalProtocol.js");
const errors_js_1 = require("./errors.js");
const protocol_js_1 = require("./protocol.js");
class CanonicalProjectClient {
    transport;
    constructor(transport) {
        this.transport = transport;
    }
    async open(projectRoot, options) {
        if (projectRoot.trim().length === 0) {
            throw new errors_js_1.ContractValidationError('must not be empty', 'projectRoot');
        }
        return this.transport.request('canonical.project.open', { projectRoot }, options);
    }
    async close(options) {
        return (await this.transport.request('canonical.project.close', {}, options)).closed;
    }
}
exports.CanonicalProjectClient = CanonicalProjectClient;
class ResidencyClient {
    transport;
    session;
    constructor(transport, session) {
        this.transport = transport;
        this.session = session;
    }
    async bootstrap(options) {
        (0, protocol_js_1.requireCapability)(this.session, 'residency.read');
        const result = await this.transport.request('canonical.residency.bootstrap', {}, options);
        if (result.schemaVersion !== 1 ||
            !Number.isSafeInteger(result.generation) ||
            result.generation < 0 ||
            !Array.isArray(result.entries)) {
            throw new errors_js_1.ContractValidationError('server returned an invalid residency bootstrap', 'response');
        }
        return result;
    }
}
exports.ResidencyClient = ResidencyClient;
class DocumentClient {
    transport;
    session;
    createRequestId;
    constructor(transport, session, options = {}) {
        this.transport = transport;
        this.session = session;
        this.createRequestId = options.createRequestId ?? defaultRequestId;
    }
    /** Low-level lossless exchange for extensions and forward-compatible relays. */
    async exchange(request, options = {}) {
        const requestId = options.requestId ?? this.createRequestId();
        validateRequestId(requestId);
        const envelope = {
            schemaId: canonicalProtocol_js_1.APP_PROTOCOL_SCHEMA_ID,
            requestId,
            request,
            ...(options.extensions === undefined ? {} : { extensions: options.extensions }),
        };
        const response = await this.transport.request('app.protocol', envelope, signalOption(options.signal));
        validateResponseEnvelope(response, requestId);
        return response;
    }
    async snapshot(options) {
        (0, protocol_js_1.requireCapability)(this.session, 'document.read');
        return this.expect(await this.exchange({ method: 'readDocumentSnapshot' }, options), 'documentSnapshot').payload;
    }
    async readJournalPage(request, options) {
        (0, protocol_js_1.requireCapability)(this.session, 'journal.read');
        validateJournalRequest(request);
        return this.expect(await this.exchange({ method: 'readJournal', params: request }, options), 'journalPage').payload;
    }
    async listAllJournalEntries(options = {}) {
        (0, protocol_js_1.requireCapability)(this.session, 'journal.read');
        const pageSize = options.pageSize ?? 250;
        const maxPages = options.maxPages ?? 10_000;
        let afterSequence = options.afterSequence ?? 0;
        validateJournalRequest({ afterSequence, limit: pageSize });
        validateMaxPages(maxPages);
        const entries = [];
        for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
            const page = await this.readJournalPage({ afterSequence, limit: pageSize }, signalOption(options.signal));
            validateJournalPage(page, afterSequence);
            entries.push(...page.entries);
            if (!page.hasMore)
                return entries;
            const last = page.entries.at(-1);
            if (last === undefined || last.sequence <= afterSequence) {
                throw new errors_js_1.ContractValidationError('server did not advance a journal page marked hasMore', 'response.entries');
            }
            afterSequence = last.sequence;
        }
        throw new errors_js_1.ContractValidationError('pagination exceeded the configured page limit', 'options.maxPages');
    }
    async readPropertySchemas(options) {
        (0, protocol_js_1.requireCapability)(this.session, 'document.read');
        return this.expect(await this.exchange({ method: 'readPropertySchemas' }, options), 'propertySchemas').payload;
    }
    async queryProperties(request, options) {
        (0, protocol_js_1.requireCapability)(this.session, 'document.read');
        return this.expect(await this.exchange({ method: 'queryProperties', params: request }, options), 'propertyQuery').payload;
    }
    async compilePropertyEdit(request, options) {
        (0, protocol_js_1.requireCapability)(this.session, 'document.write');
        return this.expect(await this.exchange({ method: 'compilePropertyEdit', params: request }, options), 'compiledTransaction').payload;
    }
    async executeCanonicalTransaction(transaction, options) {
        (0, protocol_js_1.requireCapability)(this.session, 'document.write');
        if (transaction.commandId.trim().length === 0 || transaction.mutations.length === 0) {
            throw new errors_js_1.ContractValidationError('commandId and at least one canonical mutation are required', 'transaction');
        }
        return this.expect(await this.exchange({ method: 'executeCanonicalTransaction', params: transaction }, options), 'transactionAccepted').payload;
    }
    expect(envelope, kind) {
        if (envelope.response.kind === 'error') {
            throw (0, errors_js_1.createRemoteError)({
                ...envelope.response.payload,
                retryable: false,
            });
        }
        if (envelope.response.kind !== kind) {
            throw new errors_js_1.ContractValidationError(`expected ${kind}, received ${envelope.response.kind}`, 'response.kind');
        }
        return envelope.response;
    }
}
exports.DocumentClient = DocumentClient;
/** Version-frozen provider discovery, execution and operation control. */
class IoClient {
    transport;
    session;
    constructor(transport, session) {
        this.transport = transport;
        this.session = session;
    }
    async listFormatsPage(request, options) {
        (0, protocol_js_1.requireCapability)(this.session, 'io.formats.read');
        validatePageRequest(request);
        return this.transport.request('io.formats.page', request, options);
    }
    async listAllFormats(options = {}) {
        (0, protocol_js_1.requireCapability)(this.session, 'io.formats.read');
        return collectPages((request) => this.listFormatsPage(request, signalOption(options.signal)), options);
    }
    async probe(request, options) {
        (0, protocol_js_1.requireCapability)(this.session, 'io.probe');
        validateHostPath(request.sourcePath, 'sourcePath');
        const selection = await this.transport.request('io.probe', request, options);
        validateImportSelection(selection);
        return selection;
    }
    async executeImport(request, options) {
        (0, protocol_js_1.requireCapability)(this.session, 'io.import.execute');
        validatePortableIdentity(request.operationId, 'operationId');
        validatePortableIdentity(request.commandId, 'commandId');
        validateHostPath(request.sourcePath, 'sourcePath');
        validateImportSelection(request.selection);
        return this.transport.request('io.import.execute', request, options);
    }
    async planExport(request, options) {
        (0, protocol_js_1.requireCapability)(this.session, 'io.export');
        validatePortableIdentity(request.commandId, 'commandId');
        validateRegistryId(request.providerId, 'providerId');
        validateHostPath(request.targetPath, 'targetPath');
        const accepted = await this.transport.request('io.export.plan', request, options);
        validateExportPlanEnvelope(accepted);
        return accepted;
    }
    async executeExport(operationId, acceptedPlan, options) {
        (0, protocol_js_1.requireCapability)(this.session, 'io.export');
        (0, protocol_js_1.requireCapability)(this.session, 'io.operation');
        validatePortableIdentity(operationId, 'operationId');
        validateExportPlanEnvelope(acceptedPlan);
        return this.transport.request('io.export.execute', { operationId, acceptedPlan }, options);
    }
    async operationStatus(operationId, options) {
        (0, protocol_js_1.requireCapability)(this.session, 'io.operation');
        validatePortableIdentity(operationId, 'operationId');
        return this.transport.request('io.operation.status', { operationId }, options);
    }
    async cancelOperation(operationId, options) {
        (0, protocol_js_1.requireCapability)(this.session, 'io.operation');
        validatePortableIdentity(operationId, 'operationId');
        return (await this.transport.request('io.operation.cancel', { operationId }, options))
            .cancellationRequested;
    }
}
exports.IoClient = IoClient;
/** Interactive pre-commit registration over provider-staged canonical imports. */
class RegistrationClient {
    transport;
    session;
    constructor(transport, session) {
        this.transport = transport;
        this.session = session;
    }
    async stage(request, options) {
        (0, protocol_js_1.requireCapability)(this.session, 'registration.import');
        validatePortableIdentity(request.sessionId, 'sessionId');
        validatePortableIdentity(request.commandId, 'commandId');
        validateHostPath(request.sourcePath, 'sourcePath');
        validateImportSelection(request.selection);
        validateRegistrationRecipe(request.recipe);
        return this.transport.request('registration.import.stage', request, options);
    }
    async state(sessionId, options) {
        (0, protocol_js_1.requireCapability)(this.session, 'registration.import');
        validatePortableIdentity(sessionId, 'sessionId');
        return this.transport.request('registration.session.state', { sessionId }, options);
    }
    async previewPointPairs(sessionId, pairs, options) {
        (0, protocol_js_1.requireCapability)(this.session, 'registration.import');
        validatePortableIdentity(sessionId, 'sessionId');
        if (pairs.length < 1 ||
            pairs.some((pair) => !validRegistrationPoint(pair.source) || !validRegistrationPoint(pair.target))) {
            throw new errors_js_1.ContractValidationError('at least one finite source/target pair is required', 'pairs');
        }
        return this.transport.request('registration.preview.pointPairs', { sessionId, pairs }, options);
    }
    async previewIcp(request, options) {
        (0, protocol_js_1.requireCapability)(this.session, 'registration.import');
        validatePortableIdentity(request.sessionId, 'sessionId');
        if (request.source.length < 3 ||
            request.target.length < 3 ||
            request.source.length > 2_048 ||
            request.target.length > 2_048) {
            throw new errors_js_1.ContractValidationError('ICP requires 3..2048 prepared samples per side', 'samples');
        }
        return this.transport.request('registration.preview.icp', request, options);
    }
    async sourceSamples(sessionId, maximumSamples = 2_048, options) {
        (0, protocol_js_1.requireCapability)(this.session, 'registration.import');
        validatePortableIdentity(sessionId, 'sessionId');
        if (!Number.isSafeInteger(maximumSamples) || maximumSamples < 3 || maximumSamples > 2_048) {
            throw new errors_js_1.ContractValidationError('source sample limit must be from 3 through 2048', 'limit');
        }
        return this.transport.request('registration.samples.source', { sessionId, maximumSamples }, options);
    }
    async projectPointCloudSamples(datasetId, maximumSamples = 2_048, options) {
        (0, protocol_js_1.requireCapability)(this.session, 'registration.import');
        validatePortableIdentity(datasetId, 'datasetId');
        if (!Number.isInteger(maximumSamples) || maximumSamples < 3 || maximumSamples > 2_048) {
            throw new errors_js_1.ContractValidationError('maximumSamples must be from 3 through 2048', 'samples');
        }
        return this.transport.request('registration.samples.projectPointCloud', { datasetId, maximumSamples }, options);
    }
    async commit(sessionId, options) {
        (0, protocol_js_1.requireCapability)(this.session, 'registration.import');
        validatePortableIdentity(sessionId, 'sessionId');
        return this.transport.request('registration.import.commit', { sessionId }, options);
    }
    async cancel(sessionId, options) {
        (0, protocol_js_1.requireCapability)(this.session, 'registration.import');
        validatePortableIdentity(sessionId, 'sessionId');
        return (await this.transport.request('registration.session.cancel', { sessionId }, options))
            .cancellationRequested;
    }
    async inspectSiteCalibration(path, options) {
        (0, protocol_js_1.requireCapability)(this.session, 'registration.import');
        validateHostPath(path, 'path');
        return this.transport.request('registration.siteCalibration.inspect', { path }, options);
    }
}
exports.RegistrationClient = RegistrationClient;
function validateRegistrationRecipe(recipe) {
    validatePortableIdentity(recipe.recipeId, 'recipe.recipeId');
    if (recipe.schemaVersion !== 1 || recipe.label.trim().length === 0) {
        throw new errors_js_1.ContractValidationError('unsupported or empty registration recipe', 'recipe');
    }
}
function validRegistrationPoint(point) {
    return [point.x, point.y, point.z].every(Number.isFinite);
}
function validateImportSelection(selection) {
    validateRegistryId(selection.providerId, 'selection.providerId');
    if (selection.providerVersion.trim().length === 0) {
        throw new errors_js_1.ContractValidationError('must not be empty', 'selection.providerVersion');
    }
    validateRegistryId(selection.formatId, 'selection.formatId');
    if (!Number.isSafeInteger(selection.confidence) ||
        selection.confidence < 1 ||
        selection.confidence > 100) {
        throw new errors_js_1.ContractValidationError('must be an integer from 1 through 100', 'selection.confidence');
    }
}
function validateExportPlanEnvelope(envelope) {
    if (envelope.schemaVersion !== 1) {
        throw new errors_js_1.ContractValidationError('unsupported schema version', 'acceptedPlan.schemaVersion');
    }
    validatePortableIdentity(envelope.commandId, 'acceptedPlan.commandId');
    validateRegistryId(envelope.providerId, 'acceptedPlan.providerId');
    validateHostPath(envelope.targetPath, 'acceptedPlan.targetPath');
    validateRegistryId(envelope.formatId, 'acceptedPlan.formatId');
    if (envelope.plan.formatId !== envelope.formatId ||
        envelope.plan.outputs.length === 0 ||
        envelope.plan.outputs.some((output) => output.relativePath.length === 0 || output.mediaType.length === 0)) {
        throw new errors_js_1.ContractValidationError('plan does not match its frozen request', 'acceptedPlan.plan');
    }
}
function validatePortableIdentity(value, path) {
    if (value.length === 0 || value.length > 160 || !/^[A-Za-z0-9._-]+$/.test(value)) {
        throw new errors_js_1.ContractValidationError('must be a bounded portable identity', path);
    }
}
function validateRegistryId(value, path) {
    if (value.length === 0 || value.length > 160 || !/^[a-z0-9._+@-]+$/.test(value)) {
        throw new errors_js_1.ContractValidationError('must be a bounded namespaced registry identity', path);
    }
}
function validateHostPath(value, path) {
    if (value.trim().length === 0 || value.includes('\0')) {
        throw new errors_js_1.ContractValidationError('must be a non-empty host path capability', path);
    }
}
async function collectPages(requestPage, options) {
    const pageSize = options.pageSize ?? 250;
    const maxPages = options.maxPages ?? 10_000;
    validatePageRequest({ limit: pageSize });
    validateMaxPages(maxPages);
    const items = [];
    const cursors = new Set();
    let cursor;
    for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
        const request = cursor === undefined ? { limit: pageSize } : { cursor, limit: pageSize };
        const page = await requestPage(request);
        if (!Array.isArray(page.items)) {
            throw new errors_js_1.ContractValidationError('page.items must be an array', 'page.items');
        }
        items.push(...page.items);
        // Wire JSON often serializes absent Option as null; treat null like undefined.
        const nextCursor = page.nextCursor ?? undefined;
        if (nextCursor === undefined)
            return items;
        if (nextCursor.length === 0 || cursors.has(nextCursor)) {
            throw new errors_js_1.ContractValidationError('server returned a repeated or empty cursor', 'page.nextCursor');
        }
        cursors.add(nextCursor);
        cursor = nextCursor;
    }
    throw new errors_js_1.ContractValidationError('pagination exceeded the configured page limit', 'options.maxPages');
}
function validateJournalRequest(request) {
    if (!Number.isSafeInteger(request.afterSequence) || request.afterSequence < 0) {
        throw new errors_js_1.ContractValidationError('must be a non-negative safe integer', 'afterSequence');
    }
    if (!Number.isSafeInteger(request.limit) ||
        request.limit < 1 ||
        request.limit > canonicalProtocol_js_1.APP_PROTOCOL_MAX_JOURNAL_PAGE_SIZE) {
        throw new errors_js_1.ContractValidationError(`must be an integer from 1 through ${canonicalProtocol_js_1.APP_PROTOCOL_MAX_JOURNAL_PAGE_SIZE}`, 'limit');
    }
}
function validateJournalPage(page, afterSequence) {
    if (page.afterSequence !== afterSequence) {
        throw new errors_js_1.ContractValidationError('server changed the journal cursor', 'response.afterSequence');
    }
    let previous = afterSequence;
    for (const entry of page.entries) {
        if (!Number.isSafeInteger(entry.sequence) || entry.sequence !== previous + 1) {
            throw new errors_js_1.ContractValidationError('journal entries must be contiguous and ordered', 'response.entries');
        }
        previous = entry.sequence;
    }
    if (!Number.isSafeInteger(page.journalHeadSequence) ||
        page.journalHeadSequence < previous ||
        page.hasMore !== previous < page.journalHeadSequence) {
        throw new errors_js_1.ContractValidationError('journal head metadata is inconsistent', 'response');
    }
}
function validateResponseEnvelope(response, requestId) {
    if (response.schemaId !== canonicalProtocol_js_1.APP_PROTOCOL_SCHEMA_ID) {
        throw new errors_js_1.ContractValidationError('server returned an unsupported schema', 'response.schemaId');
    }
    if (response.requestId !== requestId) {
        throw new errors_js_1.ContractValidationError('server changed the request identity', 'response.requestId');
    }
}
function validateRequestId(requestId) {
    if (requestId.trim().length === 0 || requestId.includes('\0')) {
        throw new errors_js_1.ContractValidationError('must be non-empty and contain no null byte', 'requestId');
    }
}
function validatePageRequest(request) {
    if (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 1_000) {
        throw new errors_js_1.ContractValidationError('must be an integer from 1 through 1000', 'request.limit');
    }
    if (request.cursor?.length === 0) {
        throw new errors_js_1.ContractValidationError('must not be empty', 'request.cursor');
    }
}
function validateMaxPages(maxPages) {
    if (!Number.isSafeInteger(maxPages) || maxPages < 1) {
        throw new errors_js_1.ContractValidationError('must be a positive safe integer', 'options.maxPages');
    }
}
function signalOption(signal) {
    return signal === undefined ? undefined : { signal };
}
function defaultRequestId() {
    return globalThis.crypto.randomUUID();
}
//# sourceMappingURL=clients.js.map