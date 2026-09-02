import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// POST /api/push/register — appelée par l'app au premier lancement,
// pour enregistrer le téléphone comme destinataire des alertes de but.
export async function POST(req: NextRequest) {
  const body = await req.json();
  const token = body.token as string;

  if (!token) {
    return NextResponse.json({ error: "token requis" }, { status: 400 });
  }

  await prisma.deviceToken.upsert({
    where: { token },
    update: {},
    create: { token },
  });

  return NextResponse.json({ success: true });
}
