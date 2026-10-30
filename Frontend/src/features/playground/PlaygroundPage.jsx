import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../api/client.js";
import { Button } from "../../components/Button.jsx";
import { EmptyState } from "../../components/EmptyState.jsx";
import { ErrorNotice } from "../../components/ErrorNotice.jsx";
import { PageHeader } from "../../components/PageHeader.jsx";
import { Skeleton } from "../../components/Skeleton.jsx";
import { StreamOutput } from "../../components/StreamOutput.jsx";
import { usePlaygroundStream } from "./usePlaygroundStream.js";

const EXAMPLES = [
  "Plan one day in Jaipur in three bullet points.",
  "Explain what an LLM gateway does in two sentences.",
  "Write a haiku about rate limits.",
];

const control =
  "block w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-500";

function Field({ label, hint, children }) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-sm font-medium text-slate-200">
        {label}
      </label>
      {children(id)}
      {hint && <p className="mt-1 text-xs text-slate-400">{hint}</p>}
    </div>
  );
}

function ModelSelect({ label, models, value, onChange }) {
  return (
    <Field label={label}>
      {(id) => (
        <select
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={control}
        >
          {models.map((model) => (
            <option key={model.id} value={model.id}>
              {model.id} ({model.providers.join(", ")})
            </option>
          ))}
        </select>
      )}
    </Field>
  );
}

/** Builds the POST /api/playground/chat body; returns an error message instead if invalid. */
function chatBody({ keyId, system, prompt, temperature, maxTokens }, model) {
  if (!prompt.trim()) return { error: "Enter a prompt" };
  const temp = Number(temperature);
  if (!(temp >= 0 && temp <= 2)) return { error: "Temperature must be between 0 and 2" };
  const max = maxTokens.trim();
  if (max && !/^[1-9]\d*$/.test(max)) return { error: "Max tokens must be a whole number" };
  return {
    body: {
      keyId,
      model,
      ...(system.trim() && { system: system.trim() }),
      messages: [{ role: "user", content: prompt.trim() }],
      temperature: temp,
      ...(max && { maxTokens: Number(max) }),
    },
  };
}

export function PlaygroundPage() {
  const keys = useQuery({
    queryKey: ["keys"],
    queryFn: ({ signal }) => api("/api/keys", { signal }),
  });
  const models = useQuery({
    queryKey: ["playground", "models"],
    queryFn: ({ signal }) => api("/api/playground/models", { signal }),
  });
  const left = usePlaygroundStream();
  const right = usePlaygroundStream();

  const activeKeys = (keys.data?.keys ?? []).filter((key) => !key.revokedAt);
  const modelList = models.data?.models ?? [];
  const [form, setForm] = useState({
    keyId: "",
    modelA: "",
    modelB: "",
    compare: false,
    system: "",
    prompt: "",
    temperature: "0.7",
    maxTokens: "",
  });
  const [formError, setFormError] = useState(null);
  const set = (name) => (value) => setForm((current) => ({ ...current, [name]: value }));

  // Defaults once the lists have loaded: the newest active key, and the first models.
  const keyId = form.keyId || activeKeys[0]?.id || "";
  const modelA = form.modelA || modelList[0]?.id || "";
  const modelB = form.modelB || modelList[1]?.id || modelA;
  const running = [left, right].some((s) => s.status === "waiting" || s.status === "streaming");

  const send = (event) => {
    event.preventDefault();
    const a = chatBody({ ...form, keyId }, modelA);
    if (a.error) return setFormError(a.error);
    setFormError(null);
    left.run(a.body);
    if (form.compare) right.run(chatBody({ ...form, keyId }, modelB).body);
    else right.reset();
  };

  if (keys.isError || models.isError) {
    const failed = keys.isError ? keys : models;
    return (
      <>
        <PageHeader title="Playground" />
        <ErrorNotice
          error={failed.error}
          title="Couldn't load the playground"
          onRetry={() => failed.refetch()}
        />
      </>
    );
  }
  if (keys.isPending || models.isPending) {
    return (
      <>
        <PageHeader title="Playground" />
        <Skeleton className="h-96" />
      </>
    );
  }
  if (activeKeys.length === 0) {
    return (
      <>
        <PageHeader title="Playground" />
        <EmptyState
          title="Create a key first"
          action={
            <Link to="/keys" className="text-sm font-medium text-indigo-300 hover:text-indigo-200">
              Go to API Keys
            </Link>
          }
        >
          Playground chats run as one of your gateway keys, so they count toward its usage and rate
          limit.
        </EmptyState>
      </>
    );
  }
  if (modelList.length === 0) {
    return (
      <>
        <PageHeader title="Playground" />
        <EmptyState title="No models available">
          None of the server's providers is configured. Set a provider key (or OLLAMA_BASE_URL) on
          the server and restart it.
        </EmptyState>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Playground"
        description="Stream an answer, or compare two models side by side. Each chat counts toward the key's usage and rate limit."
      />

      <form
        noValidate
        onSubmit={send}
        className="mb-6 space-y-4 rounded-lg border border-slate-800 bg-slate-900 p-4"
      >
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <Field label="Key">
            {(id) => (
              <select
                id={id}
                value={keyId}
                onChange={(e) => set("keyId")(e.target.value)}
                className={control}
              >
                {activeKeys.map((key) => (
                  <option key={key.id} value={key.id}>
                    {key.name} ({key.prefix}…)
                  </option>
                ))}
              </select>
            )}
          </Field>
          <ModelSelect
            label={form.compare ? "Model A" : "Model"}
            models={modelList}
            value={modelA}
            onChange={set("modelA")}
          />
          {form.compare && (
            <ModelSelect
              label="Model B"
              models={modelList}
              value={modelB}
              onChange={set("modelB")}
            />
          )}
        </div>

        <label className="flex items-center gap-2 text-sm text-slate-200">
          <input
            type="checkbox"
            checked={form.compare}
            onChange={(e) => set("compare")(e.target.checked)}
            className="size-4 accent-indigo-500"
          />
          Compare two models (sends two chats)
        </label>

        <Field label="System prompt" hint="Optional">
          {(id) => (
            <textarea
              id={id}
              rows={2}
              value={form.system}
              onChange={(e) => set("system")(e.target.value)}
              className={control}
            />
          )}
        </Field>
        <Field label="Prompt">
          {(id) => (
            <textarea
              id={id}
              rows={4}
              value={form.prompt}
              onChange={(e) => set("prompt")(e.target.value)}
              aria-invalid={formError === "Enter a prompt" || undefined}
              className={control}
            />
          )}
        </Field>
        {!form.prompt && (
          <div className="flex flex-wrap gap-2" aria-label="Example prompts">
            {EXAMPLES.map((example) => (
              <button
                key={example}
                type="button"
                onClick={() => set("prompt")(example)}
                className="rounded-full border border-slate-700 px-3 py-1 text-xs text-slate-300 transition-colors duration-150 hover:bg-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
              >
                {example}
              </button>
            ))}
          </div>
        )}

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:w-2/3">
          <Field label="Temperature" hint="0–2. Anthropic models use their own default">
            {(id) => (
              <input
                id={id}
                type="number"
                min="0"
                max="2"
                step="0.1"
                value={form.temperature}
                onChange={(e) => set("temperature")(e.target.value)}
                className={control}
              />
            )}
          </Field>
          <Field label="Max tokens" hint="Optional. Blank uses the model's default">
            {(id) => (
              <input
                id={id}
                inputMode="numeric"
                value={form.maxTokens}
                onChange={(e) => set("maxTokens")(e.target.value)}
                className={control}
              />
            )}
          </Field>
        </div>

        {formError && (
          <p role="alert" className="text-sm text-rose-400">
            {formError}
          </p>
        )}
        <div className="flex gap-2">
          <Button type="submit" disabled={running}>
            {form.compare ? "Run both" : "Run"}
          </Button>
          {running && (
            <Button
              variant="secondary"
              onClick={() => {
                left.stop();
                right.stop();
              }}
            >
              Stop
            </Button>
          )}
        </div>
      </form>

      <div className={`grid grid-cols-1 gap-4 ${form.compare ? "lg:grid-cols-2" : ""}`}>
        <StreamOutput title={form.compare ? `A · ${modelA}` : modelA} stream={left} />
        {form.compare && <StreamOutput title={`B · ${modelB}`} stream={right} />}
      </div>
    </>
  );
}
