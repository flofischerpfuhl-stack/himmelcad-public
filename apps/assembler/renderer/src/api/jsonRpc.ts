/**
 * JSON-RPC 2.0 framing shared by both transports (headless stdio and the
 * in-app loopback endpoint). Contract errors travel in `error.data` as
 * `{code, message, hint?, details?}`; `error.code` is the JSON-RPC number.
 */
import { ApiError, JSON_RPC_ERROR, toErrorPayload } from './errors.js';

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: unknown;
}

export type JsonRpcResponse =
  | { jsonrpc: '2.0'; id: string | number | null; result: unknown }
  | {
      jsonrpc: '2.0';
      id: string | number | null;
      error: { code: number; message: string; data: ReturnType<typeof toErrorPayload> };
    };

export interface MethodHandler {
  handle(method: string, params: unknown): Promise<unknown>;
}

function errorResponse(id: string | number | null, error: unknown): JsonRpcResponse {
  const payload = toErrorPayload(error);
  return {
    jsonrpc: '2.0',
    id,
    error: { code: JSON_RPC_ERROR[payload.code], message: payload.message, data: payload },
  };
}

/**
 * Handles one parsed JSON-RPC message. Returns `null` for notifications
 * (no `id`), as JSON-RPC requires; batches are not supported (agents call
 * sequentially; transactions provide atomic grouping).
 */
export async function handleJsonRpcMessage(
  handler: MethodHandler,
  message: unknown,
): Promise<JsonRpcResponse | null> {
  if (typeof message !== 'object' || message === null || Array.isArray(message)) {
    return errorResponse(
      null,
      new ApiError('invalidRequest', 'Expected one JSON-RPC 2.0 request object', {
        hint: 'Batches are not supported; use transaction.begin/commit to group commands.',
      }),
    );
  }
  const request = message as Partial<JsonRpcRequest>;
  const id = request.id ?? null;
  if (request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
    return errorResponse(
      id,
      new ApiError('invalidRequest', 'Expected {"jsonrpc":"2.0","method":string,"id":…}'),
    );
  }
  try {
    const result = await handler.handle(request.method, request.params);
    return request.id === undefined ? null : { jsonrpc: '2.0', id, result: result ?? null };
  } catch (error) {
    return request.id === undefined ? null : errorResponse(id, error);
  }
}

/** Parses one line/body of JSON text into a response (parse errors become JSON-RPC errors). */
export async function handleJsonRpcText(
  handler: MethodHandler,
  text: string,
): Promise<JsonRpcResponse | null> {
  let message: unknown;
  try {
    // Tolerate a UTF-8 byte-order mark (Windows shells add one when piping).
    message = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (error) {
    return {
      jsonrpc: '2.0',
      id: null,
      error: {
        code: -32700,
        message: 'Parse error',
        data: {
          code: 'invalidRequest',
          message: `Invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
        },
      },
    };
  }
  return handleJsonRpcMessage(handler, message);
}
