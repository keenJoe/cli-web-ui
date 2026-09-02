import { useCallback, useState } from 'react';

import type { PermissionPanelProps } from '../../configs/permissionPanelRegistry';

type PiExtensionUiInput = {
  method?: 'select' | 'confirm' | 'input' | 'editor';
  title?: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
};

/**
 * Permission panel for Pi extension UI dialogs.
 *
 * The Pi runtime relays blocking `extension_ui_request` events as
 * `permission_request` frames with `toolName === 'pi-extension-ui'`. This panel
 * renders the four dialog methods the RPC protocol supports and answers through
 * the shared `onDecision` → `chat.permission-response` channel:
 *
 * - `confirm` → `{ allow }`        (runtime maps to `confirmed`/deny)
 * - `select`  → `{ allow, updatedInput: option }`
 * - `input`   → `{ allow, updatedInput: text }`
 * - `editor`  → `{ allow, updatedInput: text }`
 * - a cancel  → `{ allow: false }` (runtime maps to `cancelled`)
 */
export function PiExtensionUiPanel({ request, onDecision }: PermissionPanelProps) {
  const input = (request.input ?? {}) as PiExtensionUiInput;
  const method = input.method ?? 'confirm';

  const [text, setText] = useState(input.prefill ?? '');
  const [selected, setSelected] = useState<string | null>(null);

  const decide = useCallback(
    (decision: { allow?: boolean; updatedInput?: unknown }) =>
      onDecision(request.requestId, decision),
    [onDecision, request.requestId],
  );

  const title = input.title || (method === 'confirm' ? 'Confirm' : 'Input required');
  const message = input.message;

  return (
    <div className="mb-3 rounded-lg border border-gray-200 bg-white p-3 shadow-sm dark:border-gray-700 dark:bg-gray-800">
      <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500">
        Pi extension
      </div>
      <div className="text-sm font-medium text-gray-900 dark:text-gray-100">{title}</div>
      {message && (
        <p className="mt-1 whitespace-pre-wrap text-xs text-gray-600 dark:text-gray-300">{message}</p>
      )}

      {method === 'confirm' && (
        <div className="mt-3 flex gap-2">
          <button
            type="button"
            onClick={() => decide({ allow: true })}
            className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700"
          >
            Allow
          </button>
          <button
            type="button"
            onClick={() => decide({ allow: false })}
            className="rounded-md border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
          >
            Deny
          </button>
        </div>
      )}

      {method === 'select' && (
        <div className="mt-2 space-y-1">
          {(input.options ?? []).map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => {
                setSelected(option);
                decide({ allow: true, updatedInput: option });
              }}
              className={`w-full rounded-md border px-3 py-1.5 text-left text-xs transition-colors ${
                selected === option
                  ? 'border-blue-400 bg-blue-50 text-blue-700 dark:border-blue-600 dark:bg-blue-900/30 dark:text-blue-300'
                  : 'border-gray-200 text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-700'
              }`}
            >
              {option}
            </button>
          ))}
          <button
            type="button"
            onClick={() => decide({ allow: false })}
            className="w-full rounded-md border border-dashed border-gray-300 px-3 py-1.5 text-left text-xs text-gray-500 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-400 dark:hover:bg-gray-700"
          >
            Cancel
          </button>
        </div>
      )}

      {(method === 'input' || method === 'editor') && (
        <div className="mt-2">
          {method === 'editor' ? (
            <textarea
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder={input.placeholder}
              rows={5}
              className="w-full rounded-md border border-gray-300 bg-gray-50 px-3 py-2 text-sm text-gray-900 outline-none ring-0 focus:border-blue-400 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
            />
          ) : (
            <input
              type="text"
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder={input.placeholder}
              className="w-full rounded-md border border-gray-300 bg-gray-50 px-3 py-1.5 text-sm text-gray-900 outline-none ring-0 focus:border-blue-400 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
            />
          )}
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              onClick={() => decide({ allow: true, updatedInput: text })}
              className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700"
            >
              Submit
            </button>
            <button
              type="button"
              onClick={() => decide({ allow: false })}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}