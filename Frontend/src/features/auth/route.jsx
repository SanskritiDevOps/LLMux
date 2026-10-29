import { LoginPage } from "./LoginPage.jsx";
import { RegisterPage } from "./RegisterPage.jsx";

export const routes = [
  { path: "/login", element: <LoginPage />, public: true },
  { path: "/register", element: <RegisterPage />, public: true },
];
