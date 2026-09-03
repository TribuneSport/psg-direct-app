import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const status = searchParams.get("status");
  const search = searchParams.get("search");

  const articles = await prisma.article.findMany({
    where: {
      ...(status ? { status: status as any } : {}),
      ...(search ? { title: { contains: search, mode: "insensitive" } } : {}),
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true, title: true, slug: true, excerpt: true, club: true,
      status: true, isAiGenerated: true, createdAt: true, publishedAt: true,
    },
  });

  return NextResponse.json({ articles });
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  if (!body.title || !body.content || !body.club) {
    return NextResponse.json({ error: "title, content et club sont requis" }, { status: 400 });
  }
  const slug = slugify(body.title);
  const article = await prisma.article.create({
    data: {
      title: body.title,
      slug,
      content: body.content,
      excerpt: body.excerpt ?? null,
      club: body.club,
      status: "DRAFT",
      isAiGenerated: false,
    },
  });
  return NextResponse.json({ article }, { status: 201 });
}

function slugify(title: string) {
  return (
    title
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "") + "-" + Date.now().toString(36)
  );
}
