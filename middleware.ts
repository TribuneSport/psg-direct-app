import { NextRequest, NextResponse } from "next/server";

// Protège tout ce qui commence par /admin (l'interface) et /api/admin
// (les routes qui permettent de créer/modifier/supprimer des articles).
// Le score en direct et l'API publique des articles restent accessibles
// sans mot de passe, comme il se doit pour l'app.
export function middleware(req: NextRequest) {
  const auth = req.headers.get("authorization");

  const expectedPassword = process.env.ADMIN_PASSWORD;

  if (!expectedPassword) {
    // Sécurité : si la variable n'est pas configurée, on bloque tout par
    // précaution plutôt que de laisser le backoffice grand ouvert.
    return new NextResponse("Configuration manquante (ADMIN_PASSWORD)", { status: 500 });
  }

  if (auth) {
    const [, encoded] = auth.split(" ");
    const decoded = Buffer.from(encoded, "base64").toString();
    const [, password] = decoded.split(":"); // identifiant ignoré, seul le mot de passe compte

    if (password === expectedPassword) {
      return NextResponse.next();
    }
  }

  return new NextResponse("Authentification requise", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="PSG Direct Admin"' },
  });
}

export const config = {
  matcher: ["/admin/:path*", "/api/admin/:path*"],
};
