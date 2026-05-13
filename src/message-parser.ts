const SENSITIVE_KEYS = [
  'password',
  'passphrase',
  'secret',
  'srp',
  'seed',
  'mnemonic',
  'privatekey',
  'private_key',
  'entropy',
  'credential',
  'authorization',
  'token',
  'apikey',
  'api_key',
  'keyring',
];

/**
 * Recursively redacts values whose keys match known sensitive patterns.
 *
 * @param input - The value to redact.
 * @returns The redacted value.
 */
export function redactSensitive(input: unknown): unknown {
  if (typeof input !== 'object' || input === null) {
    return input;
  }

  if (Array.isArray(input)) {
    return input.map(redactSensitive);
  }

  const obj = { ...(input as Record<string, unknown>) };

  for (const [key, value] of Object.entries(obj)) {
    if (
      SENSITIVE_KEYS.some((sensitiveKey) =>
        key.toLowerCase().includes(sensitiveKey),
      )
    ) {
      obj[key] = '[REDACTED]';
    } else if (typeof value === 'object' && value !== null) {
      obj[key] = redactSensitive(value);
    }
  }

  return obj;
}

/**
 * Extracts concatenated text from all text content blocks in an SDK message.
 *
 * @param message - The SDK message to parse.
 * @returns The extracted text content.
 */
export function extractTextContent(message: Record<string, unknown>): string {
  const { content } = message;

  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .filter(isTextBlock)
    .map((block) => block.text)
    .join('');
}

/**
 * Extracts all tool use content blocks from an SDK message.
 *
 * @param message - The SDK message to parse.
 * @returns The extracted tool use blocks.
 */
export function extractToolUseBlocks(message: Record<string, unknown>): {
  /** Tool call identifier. */
  id: string;
  /** Tool name. */
  name: string;
  /** Tool input arguments. */
  input: unknown;
}[] {
  const { content } = message;

  if (!Array.isArray(content)) {
    return [];
  }

  return content.filter(isToolUseBlock).map(({ id, name, input }) => ({
    id,
    name,
    input,
  }));
}

/**
 * Type guard that checks whether a value is a text content block.
 *
 * @param input - The value to check.
 * @returns Whether the input is a valid text block.
 */
function isTextBlock(input: unknown): input is {
  /** Block type discriminant. */
  type: 'text';
  /** Text content of the block. */
  text: string;
} {
  return (
    typeof input === 'object' &&
    input !== null &&
    'type' in input &&
    input.type === 'text' &&
    'text' in input &&
    typeof input.text === 'string'
  );
}

/**
 * Type guard that checks whether a value is a tool use content block.
 *
 * @param input - The value to check.
 * @returns Whether the input is a valid tool use block.
 */
function isToolUseBlock(input: unknown): input is {
  /** Block type discriminant. */
  type: 'tool_use';
  /** Tool call identifier. */
  id: string;
  /** Tool name. */
  name: string;
  /** Tool input arguments. */
  input: unknown;
} {
  return (
    typeof input === 'object' &&
    input !== null &&
    'type' in input &&
    input.type === 'tool_use' &&
    'id' in input &&
    typeof input.id === 'string' &&
    'name' in input &&
    typeof input.name === 'string' &&
    'input' in input
  );
}
