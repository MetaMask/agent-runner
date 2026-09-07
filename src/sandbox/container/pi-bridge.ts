import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createCredentialScrubber,
  scrubCredentials,
} from '../../credential-redactor.js';
import { runPiSession } from '../../pi-runtime.js';
import type { PiStructuredOutput } from '../../pi-runtime.js';

/**
 * Runs the container protocol using the same pi implementation as direct runs.
 *
 * @param stdin - Single JSON request stream.
 * @param stdout - JSONL response stream.
 * @param run - Shared runtime, injectable for protocol tests.
 * @returns Process exit code.
 */
export async function runPiBridge(
  stdin: NodeJS.ReadableStream,
  stdout: NodeJS.WritableStream,
  run = runPiSession,
): Promise<number> {
  const scrub = createCredentialScrubber();
  /**
   * Writes one bounded frame and waits for stream completion.
   *
   * @param event - Protocol frame.
   */
  const write = async (event: object): Promise<void> => {
    const line = `${JSON.stringify(event)}\n`;
    if (Buffer.byteLength(line) > 10 * 1024 * 1024) {
      throw new Error('Pi bridge frame exceeds 10 MiB.');
    }
    await new Promise<void>((resolve, reject) => {
      stdout.write(line, (error?: Error | null) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  };
  try {
    stdin.setEncoding('utf8');
    let text = '';
    for await (const chunk of stdin) {
      text += String(chunk);
      if (Buffer.byteLength(text) > 10 * 1024 * 1024) {
        throw new Error('Pi bridge request exceeds 10 MiB.');
      }
    }
    const request = JSON.parse(text) as Record<string, unknown>;
    if (
      request?.version !== 1 ||
      request.type !== 'run' ||
      typeof request.prompt !== 'string' ||
      request.options === null ||
      typeof request.options !== 'object' ||
      Array.isArray(request.options)
    ) {
      throw new Error('Invalid pi bridge request.');
    }
    const { structured, ...options } = request.options as Record<
      string,
      unknown
    >;
    if (
      structured !== undefined &&
      (structured === null ||
        typeof structured !== 'object' ||
        !('schema' in structured) ||
        structured.schema === null ||
        typeof structured.schema !== 'object' ||
        !('systemPrompt' in structured) ||
        typeof structured.systemPrompt !== 'string')
    ) {
      throw new Error('Invalid pi structured-output contract.');
    }
    for await (const message of run(
      request.prompt,
      options,
      structured as PiStructuredOutput | undefined,
    )) {
      await write({ version: 1, type: 'message', message });
    }
    await write({ version: 1, type: 'done' });
    return 0;
  } catch (cause) {
    const error = scrubCredentials(
      cause instanceof Error ? cause : new Error(String(cause)),
      scrub,
    );
    try {
      await write({
        version: 1,
        type: 'error',
        error: { name: error.name, message: error.message, stack: error.stack },
      });
    } catch {
      throw error;
    }
    return 1;
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  runPiBridge(process.stdin, process.stdout)
    .then((code) => {
      process.exitCode = code;
      return undefined;
    })
    .catch(() => {
      process.exitCode = 1;
    });
}
