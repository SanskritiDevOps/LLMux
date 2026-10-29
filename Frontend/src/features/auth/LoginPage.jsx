import { Link } from "react-router-dom";
import { Button } from "../../components/Button.jsx";
import { ErrorNotice } from "../../components/ErrorNotice.jsx";
import { FormField } from "../../components/FormField.jsx";
import { isEmail } from "../../lib/forms.js";
import { AuthLayout } from "./AuthLayout.jsx";
import { useAuthForm } from "./useAuthForm.js";

// Login only checks that something was typed: stricter rules belong to registration, so
// an old account can never be locked out by a newer rule.
function validate({ email, password }) {
  return {
    email: !email.trim() ? "Enter your email" : !isEmail(email) ? "Enter a valid email" : undefined,
    password: !password ? "Enter your password" : undefined,
  };
}

export function LoginPage() {
  const { field, onSubmit, formError, pending } = useAuthForm({
    path: "/api/auth/login",
    initial: { email: "", password: "" },
    validate,
  });

  return (
    <AuthLayout
      title="Log in"
      footer={
        <>
          No account yet?{" "}
          <Link to="/register" className="font-medium text-indigo-300 hover:text-indigo-200">
            Create one
          </Link>
        </>
      }
    >
      <form noValidate onSubmit={onSubmit} className="space-y-4">
        {formError && <ErrorNotice error={formError} title="Couldn't log in" />}
        <FormField label="Email" type="email" autoComplete="email" {...field("email")} />
        <FormField
          label="Password"
          type="password"
          autoComplete="current-password"
          {...field("password")}
        />
        <Button type="submit" loading={pending} className="w-full">
          Log in
        </Button>
      </form>
    </AuthLayout>
  );
}
