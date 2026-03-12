import { createRootRoute, Outlet } from "@tanstack/react-router";
import { ThemeProvider } from "@/lib/theme";
import { Layout } from "@/components/layout";

export const Route = createRootRoute({
  component: RootComponent,
});

function RootComponent() {
  return (
    <ThemeProvider>
      <Layout>
        <Outlet />
      </Layout>
    </ThemeProvider>
  );
}
