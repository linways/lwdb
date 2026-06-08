<script setup>
import { onMounted, onBeforeUnmount, ref, watch } from 'vue';
import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection } from '@codemirror/view';
import { EditorState, Compartment } from '@codemirror/state';
import { defaultKeymap, history as cmHistory, historyKeymap, indentWithTab } from '@codemirror/commands';
import {
  sql, MySQL,
  schemaCompletionSource, keywordCompletionSource,
} from '@codemirror/lang-sql';
import { oneDark } from '@codemirror/theme-one-dark';
import { autocompletion, completionKeymap } from '@codemirror/autocomplete';
import { bracketMatching, syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import { store } from '../store.js';
import { fromAwareColumnSource } from '../sqlCompletion.js';

const props = defineProps({ modelValue: { type: String, default: '' } });
const emit = defineEmits(['update:modelValue', 'run', 'selection']);

const host = ref(null);
let view = null;
// Compartments let us swap parts of the configuration without recreating the
// editor. Used for: the SQL language (schema changes), the editor appearance
// (font size, line wrap), and the gutter (line numbers toggle).
const sqlCompartment = new Compartment();
const appearanceCompartment = new Compartment();
const gutterCompartment = new Compartment();
const themeCompartment = new Compartment();

function buildAppearance() {
  const exts = [
    EditorView.theme({
      '&': { fontSize: `${store.prefs.editorFontSize || 13}px` },
    }),
  ];
  if (store.prefs.wordWrap) exts.push(EditorView.lineWrapping);
  return exts;
}

function buildGutter() {
  return store.prefs.showLineNumbers !== false ? [lineNumbers()] : [];
}

// Light surface theme (var-driven) for when oneDark is off. Dark uses oneDark.
const lightEditorTheme = EditorView.theme({
  '&': { backgroundColor: 'var(--bg-2)', color: 'var(--text)' },
  '.cm-gutters': { backgroundColor: 'var(--bg-2)', color: 'var(--text-faint)', border: 'none' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--text)' },
  '.cm-activeLine': { backgroundColor: 'var(--bg-3)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--bg-3)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: 'var(--bg-hover)' },
}, { dark: false });

function editorThemeFor(mode) {
  return mode === 'dark' ? [oneDark] : [lightEditorTheme];
}

// A small wrapper that always reads the *live* store.schema each time the
// completion source runs. We can't reuse a stale snapshot because schema may
// arrive after the compartment is configured.
const liveSchemaRef = {
  get value() { return store.schema; },
};

// Wrap a completion source so accepting any option inserts a trailing space —
// so after picking SELECT / WHERE / LIKE / a table / a column you can keep
// typing immediately (e.g. "SELECT " then columns, "FROM students " then WHERE).
// Options with a custom function `apply` are left untouched.
function withTrailingSpace(source) {
  return async (context) => {
    const result = await source(context);
    if (!result || !result.options) return result;
    return {
      ...result,
      options: result.options.map((o) =>
        (typeof o.apply === 'function'
          ? o
          : { ...o, apply: `${o.apply ?? o.label} ` })),
    };
  };
}

function buildSqlExtension() {
  const schema = store.schema?.tables || {};
  const upper = !!store.prefs.uppercaseKeywords;
  return [
    sql({ dialect: MySQL, schema, upperCaseKeywords: upper }),
    autocompletion({
      override: [
        withTrailingSpace(fromAwareColumnSource(liveSchemaRef)),
        withTrailingSpace(schemaCompletionSource({ dialect: MySQL, schema, upperCaseKeywords: upper })),
        withTrailingSpace(keywordCompletionSource(MySQL, upper)),
      ],
    }),
  ];
}

onMounted(() => {
  const state = EditorState.create({
    doc: props.modelValue,
    extensions: [
      gutterCompartment.of(buildGutter()),
      drawSelection(),
      highlightActiveLine(),
      bracketMatching(),
      highlightSelectionMatches(),
      cmHistory(),
      // autocompletion() lives inside buildSqlExtension() so it gets
      // reconfigured (with fresh schema) whenever the active db changes.
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      sqlCompartment.of(buildSqlExtension()),
      themeCompartment.of(editorThemeFor(store.themeMode)),
      appearanceCompartment.of(buildAppearance()),
      // Our run-query binding goes first — defaultKeymap binds Mod-Enter to
      // insertBlankLine and the first match wins inside a single keymap.of().
      keymap.of([
        {
          key: 'Mod-Enter',
          preventDefault: true,
          run: () => { emit('run'); return true; },
        },
        {
          key: 'F5',
          preventDefault: true,
          run: () => { emit('run'); return true; },
        },
        ...defaultKeymap,
        ...historyKeymap,
        ...completionKeymap,
        ...searchKeymap,
        indentWithTab,
      ]),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) emit('update:modelValue', u.state.doc.toString());
        if (u.docChanged || u.selectionSet) {
          const sel = u.state.selection.main;
          emit('selection', {
            head: sel.head,
            from: Math.min(sel.anchor, sel.head),
            to: Math.max(sel.anchor, sel.head),
          });
        }
      }),
      EditorView.theme({
        '&': { height: '100%' },
        '.cm-scroller': { fontFamily: 'var(--font-mono)' },
        '.cm-content': { padding: '12px 0 12px 0' },
        '.cm-gutters': { backgroundColor: 'transparent', borderRight: '1px solid var(--border)' },
      }),
    ],
  });
  view = new EditorView({ state, parent: host.value });
});

onBeforeUnmount(() => view?.destroy());

watch(() => props.modelValue, (val) => {
  if (!view) return;
  const current = view.state.doc.toString();
  if (val !== current) {
    view.dispatch({ changes: { from: 0, to: current.length, insert: val } });
  }
});

// Reactive schema: when the active db's schema loads or changes, reconfigure
// the SQL compartment so completions reflect the new table/column set.
watch(
  () => store.schema?.fetchedAt,
  () => {
    if (!view) return;
    view.dispatch({ effects: sqlCompartment.reconfigure(buildSqlExtension()) });
  },
);

watch(
  () => store.themeMode,
  (mode) => {
    if (!view) return;
    view.dispatch({ effects: themeCompartment.reconfigure(editorThemeFor(mode)) });
  },
);

// Live-apply appearance + gutter prefs (font size, wrap, line numbers,
// uppercase keywords).
watch(
  () => [
    store.prefs.editorFontSize,
    store.prefs.wordWrap,
    store.prefs.showLineNumbers,
    store.prefs.uppercaseKeywords,
  ],
  () => {
    if (!view) return;
    view.dispatch({
      effects: [
        appearanceCompartment.reconfigure(buildAppearance()),
        gutterCompartment.reconfigure(buildGutter()),
        sqlCompartment.reconfigure(buildSqlExtension()),
      ],
    });
  },
);
</script>

<template>
  <div
    ref="host"
    class="cm-host"
  />
</template>
