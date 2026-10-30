import { useState } from "react";
import { Button } from "../../components/Button.jsx";
import { ErrorNotice } from "../../components/ErrorNotice.jsx";
import { FormField } from "../../components/FormField.jsx";
import { fieldErrorsFrom } from "../../lib/forms.js";

const FIELDS = ["name", "rateLimitPerMin"];

// The same rules as the API: a name of 1–100 characters, and a whole-number limit from 1
// to 10,000 per minute. A blank limit means the server default.
function validate({ name, rateLimitPerMin }) {
  const limit = rateLimitPerMin.trim();
  return {
    name: !name.trim()
      ? "Enter a name"
      : name.trim().length > 100
        ? "At most 100 characters"
        : undefined,
    rateLimitPerMin:
      limit && !(/^\d+$/.test(limit) && Number(limit) >= 1 && Number(limit) <= 10_000)
        ? "A whole number from 1 to 10,000, or blank for the default"
        : undefined,
  };
}

/**
 * The name and rate limit form, for creating and editing a key. `onSubmit` receives
 * { name, rateLimitPerMin } with the limit as a number, or null for the default.
 */
export function KeyForm({ initial, submitLabel, mutation, onSubmit, onCancel }) {
  const [values, setValues] = useState({
    name: initial?.name ?? "",
    rateLimitPerMin: initial?.rateLimitPerMin ? String(initial.rateLimitPerMin) : "",
  });
  const [errors, setErrors] = useState({});

  const field = (name) => ({
    value: values[name],
    error: errors[name] ?? fieldErrorsFrom(mutation.error, FIELDS)[name],
    onChange: (event) => setValues((current) => ({ ...current, [name]: event.target.value })),
    onBlur: () => setErrors((current) => ({ ...current, [name]: validate(values)[name] })),
  });

  const submit = (event) => {
    event.preventDefault();
    const found = validate(values);
    setErrors(found);
    if (Object.values(found).some(Boolean)) return;
    const limit = values.rateLimitPerMin.trim();
    onSubmit({ name: values.name.trim(), rateLimitPerMin: limit ? Number(limit) : null });
  };

  const formError =
    mutation.isError && Object.keys(fieldErrorsFrom(mutation.error, FIELDS)).length === 0
      ? mutation.error
      : null;

  return (
    <form noValidate onSubmit={submit} className="space-y-4">
      {formError && <ErrorNotice error={formError} />}
      <FormField label="Name" autoFocus {...field("name")} />
      <FormField
        label="Rate limit per minute"
        inputMode="numeric"
        hint="Optional. Blank uses the server default."
        {...field("rateLimitPerMin")}
      />
      <div className="flex justify-end gap-2 pt-2">
        <Button variant="secondary" onClick={onCancel} disabled={mutation.isPending}>
          Cancel
        </Button>
        <Button type="submit" loading={mutation.isPending}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
