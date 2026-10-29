import { Link } from "react-router-dom";
import { Button } from "../../components/Button.jsx";
import { ErrorNotice } from "../../components/ErrorNotice.jsx";
import { FormField } from "../../components/FormField.jsx";
import { byteLength, isEmail } from "../../lib/forms.js";
import { AuthLayout } from "./AuthLayout.jsx";
import { useAuthForm } from "./useAuthForm.js";

// The same rules as the API (docs/API.md section 5), so most mistakes are caught here.
function validate({ name, email, password }) {
  return {
    name: !name.trim()
      ? "Enter your name"
      : name.trim().length > 100
        ? "At most 100 characters"
        : undefined,
    email: !email.trim() ? "Enter your email" : !isEmail(email) ? "Enter a valid email" : undefined,
    password:
      password.length < 8
        ? "At least 8 characters"
        : byteLength(password) > 72
          ? "At most 72 bytes (fewer if you use emoji or accents)"
          : undefined,
  };
}

export function RegisterPage() {
  const { field, onSubmit, formError, pending } = useAuthForm({
    path: "/api/auth/register",
    initial: { name: "", email: "", password: "" },
    validate,
  });

  return (
    <AuthLayout
      title="Create an account"
      footer={
        <>
          Already have one?{" "}
          <Link to="/login" className="font-medium text-indigo-300 hover:text-indigo-200">
            Log in
          </Link>
        </>
      }
    >
      <form noValidate onSubmit={onSubmit} className="space-y-4">
        {formError && <ErrorNotice error={formError} title="Couldn't create the account" />}
        <FormField label="Name" autoComplete="name" {...field("name")} />
        <FormField label="Email" type="email" autoComplete="email" {...field("email")} />
        <FormField
          label="Password"
          type="password"
          autoComplete="new-password"
          hint="At least 8 characters"
          {...field("password")}
        />
        <Button type="submit" loading={pending} className="w-full">
          Create account
        </Button>
      </form>
    </AuthLayout>
  );
}
