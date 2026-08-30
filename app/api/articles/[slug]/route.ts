import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET(_req: NextRequest, { params }: { params: { slug: string } }) {
  const article = await prisma.article.findFirst({
    where: { slug: params.slug, status: "PUBLISHED" },
    select: { id: true, title: true, slug: true, content: true, club: true, publishedAt: true },
  });
  if (!article) return NextResponse.json({ error: "Article introuvable" }, { status: 404 });
  return NextResponse.json({ article });
}
