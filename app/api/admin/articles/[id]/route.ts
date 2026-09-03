import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const article = await prisma.article.findUnique({ where: { id: params.id } });
  if (!article) return NextResponse.json({ error: "Article introuvable" }, { status: 404 });
  return NextResponse.json({ article });
}

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  const body = await req.json();
  const data: any = {
    ...(body.title !== undefined ? { title: body.title } : {}),
    ...(body.content !== undefined ? { content: body.content } : {}),
    ...(body.excerpt !== undefined ? { excerpt: body.excerpt } : {}),
    ...(body.club !== undefined ? { club: body.club } : {}),
  };
  if (body.status !== undefined) {
    data.status = body.status;
    if (body.status === "PUBLISHED") data.publishedAt = new Date();
  }
  const article = await prisma.article.update({ where: { id: params.id }, data });
  return NextResponse.json({ article });
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  await prisma.article.delete({ where: { id: params.id } });
  return NextResponse.json({ success: true });
}
