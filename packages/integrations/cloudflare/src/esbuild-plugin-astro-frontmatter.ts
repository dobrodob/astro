import { readFile } from 'node:fs/promises';
import type { DepOptimizationConfig } from 'vite';

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---/;

const RETURN_WORD_RE = /\breturn(\s*;|\b)/g;

// Characters that, when they are the last significant token before `/`,
// indicate the `/` opens a regex literal rather than a division operator.
// Covers operators, assignment, punctuation, and opening brackets.
const REGEX_BEFORE = new Set('=+*%!&|^~<>?:,;({[/\n-');

/**
 * Rewrites `return` → `throw` in frontmatter code while skipping occurrences
 * inside strings, template literals, comments, and regex literals.
 *
 * Uses a character-level scanner instead of a single regex so that every
 * quoted-context type (including regex literals) is handled correctly.
 */
function replaceTopLevelReturns(code: string): string {
	let result = '';
	let i = 0;
	// Tracks the last non-whitespace character for regex-vs-division disambiguation.
	let lastSignificant = '\n';

	while (i < code.length) {
		const ch = code[i];

		// Line comment
		if (ch === '/' && code[i + 1] === '/') {
			const end = code.indexOf('\n', i);
			if (end === -1) {
				result += code.slice(i);
				i = code.length;
			} else {
				result += code.slice(i, end);
				i = end; // '\n' consumed on next iteration
			}
			continue;
		}

		// Block comment
		if (ch === '/' && code[i + 1] === '*') {
			const end = code.indexOf('*/', i + 2);
			if (end === -1) {
				result += code.slice(i);
				i = code.length;
			} else {
				result += code.slice(i, end + 2);
				i = end + 2;
			}
			continue;
		}

		// Regex literal: `/` is a regex start when preceded by an operator,
		// punctuation, or line start — not by an identifier, number, or `)` / `]`.
		if (ch === '/' && REGEX_BEFORE.has(lastSignificant)) {
			const start = i;
			i++; // skip opening `/`
			while (i < code.length) {
				if (code[i] === '\\') {
					i += 2; // skip escaped character
				} else if (code[i] === '/') {
					i++; // skip closing `/`
					// consume optional flags (gimsuy, etc.)
					while (i < code.length && /[a-z]/i.test(code[i])) i++;
					break;
				} else if (code[i] === '\n') {
					// Unterminated — not actually a regex; treat opening `/` as division.
					i = start + 1;
					break;
				} else {
					i++;
				}
			}
			result += code.slice(start, i);
			lastSignificant = '/';
			continue;
		}

		// String: single-quoted, double-quoted, or template literal
		if (ch === '"' || ch === "'" || ch === '`') {
			const start = i;
			i++; // skip opening quote
			while (i < code.length) {
				if (code[i] === '\\') {
					i += 2;
				} else if (code[i] === ch) {
					i++;
					break;
				} else {
					i++;
				}
			}
			result += code.slice(start, i);
			lastSignificant = ch;
			continue;
		}

		// Possible `return` keyword
		if (ch === 'r' && code.slice(i, i + 6) === 'return') {
			// Must be a word boundary before: not preceded by `.` or an identifier char
			const before = i > 0 ? code[i - 1] : '';
			const isWordBefore = before !== '' && /[\w.$]/.test(before);

			if (!isWordBefore) {
				RETURN_WORD_RE.lastIndex = i;
				const m = RETURN_WORD_RE.exec(code);
				if (m && m.index === i) {
					const tail = m[1];
					result += tail.trim() === ';' ? 'throw 0;' : 'throw ';
					i = m.index + m[0].length;
					lastSignificant = ' ';
					continue;
				}
			}
		}

		result += ch;
		if (ch !== ' ' && ch !== '\t' && ch !== '\r') {
			lastSignificant = ch;
		}
		i++;
	}

	return result;
}

// Not exposed as a type from Vite, so need to grab this way.
type ESBuildPlugin = NonNullable<
	NonNullable<DepOptimizationConfig['esbuildOptions']>['plugins']
>[0];

/**
 * An esbuild plugin that extracts frontmatter from .astro files during
 * dependency optimization scanning. This allows Vite to discover imports
 * in the server-side frontmatter code.
 */
export function astroFrontmatterScanPlugin(): ESBuildPlugin {
	return {
		name: 'astro-frontmatter-scan',
		setup(build) {
			// Scope to the "file" namespace so that .astro files resolved into the
			// "html" namespace (e.g. when a .ts file default-imports a component)
			// fall through to Vite's built-in html-type handler, which appends
			// `export default {}` and avoids "No matching export" errors.
			build.onLoad({ filter: /\.astro$/, namespace: 'file' }, async (args) => {
				try {
					const code = await readFile(args.path, 'utf-8');

					// Extract frontmatter content between --- markers
					const frontmatterMatch = FRONTMATTER_RE.exec(code);
					if (frontmatterMatch) {
						// Replace `return` with `throw` to avoid esbuild's "Top-level return" error during scanning.
						// This aligns with Astro's core compiler logic for frontmatter error handling.
						// See: packages/astro/src/vite-plugin-astro/compile.ts
						const contents = replaceTopLevelReturns(frontmatterMatch[1]);

						// Append `export default {}` so that default imports of .astro files
						// (e.g. `import MyComponent from './MyComponent.astro'`) resolve correctly
						// during the dep scan. Without this, .astro files loaded in the `html`
						// namespace (when imported from .ts files) would have no default export,
						// causing esbuild to fail with "No matching export for import 'default'".
						return {
							contents: contents + '\nexport default {}',
							loader: 'ts',
						};
					}
				} catch {
					// Ignore read errors
				}

				// No frontmatter or read error, return empty with a default export
				return {
					contents: 'export default {}',
					loader: 'ts',
				};
			});
		},
	};
}
