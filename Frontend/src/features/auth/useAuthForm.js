import { useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useAuthMutation } from "../../hooks/useSession.js";
import { fieldErrorsFrom } from "../../lib/forms.js";

/**
 * Shared state for the login and register forms. Fields are checked when they lose focus
 * and again on submit; server validation errors go under the field they name, anything
 * else becomes the form-level error. On success, the user goes back to the page they
 * first asked for.
 *
 * @param {{ path: string, initial: Record<string, string>,
 *   validate: (values: Record<string, string>) => Record<string, string> }} options
 */
export function useAuthForm({ path, initial, validate }) {
  const [values, setValues] = useState(initial);
  const [errors, setErrors] = useState({});
  const mutation = useAuthMutation(path);
  const navigate = useNavigate();
  const location = useLocation();
  const fields = Object.keys(initial);

  const field = (name) => ({
    name,
    value: values[name],
    error: errors[name],
    onChange: (event) => setValues((current) => ({ ...current, [name]: event.target.value })),
    onBlur: () => setErrors((current) => ({ ...current, [name]: validate(values)[name] })),
  });

  const onSubmit = (event) => {
    event.preventDefault();
    const found = validate(values);
    setErrors(found);
    if (Object.values(found).some(Boolean)) return;

    mutation.mutate(values, {
      onSuccess: () => navigate(location.state?.from?.pathname ?? "/", { replace: true }),
      onError: (error) => setErrors(fieldErrorsFrom(error, fields)),
    });
  };

  // A server error that names one of the fields is already shown under it.
  const formError =
    mutation.isError && Object.keys(fieldErrorsFrom(mutation.error, fields)).length === 0
      ? mutation.error
      : null;

  return { field, onSubmit, formError, pending: mutation.isPending };
}
