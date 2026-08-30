import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { ids, action } = body as { ids: string[]; action: string };

  if (!Array.isArray(ids) || ids.length === 0) {
    return NextResponse.json({ error: "ids requis" }, { status: 400 });
  }

  switch (action) {
    case "publish":
      await prisma.article.updateMany({ where: { id: { in: ids } }, data: { status: "PUBLISHED", publishedAt: new Date() } });
      break;
    case "unpublish":
      await prisma.article.updateMany({ where: { id: { in: ids } }, data: { status: "UNPUBLISHED" } });
      break;
    case "delete":
      await prisma.article.deleteMany({ where: { id: { in: ids } } });
      break;
    default:
      return NextResponse.json({ error: "action invalide" }, { status: 400 });
  }

  return NextResponse.json({ success: true, count: ids.length, action });
}
