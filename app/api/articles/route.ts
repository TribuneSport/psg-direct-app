import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const club = searchParams.get("club");
  const limit = Math.min(Number(searchParams.get("limit") ?? 20), 50);

  const articles = await prisma.article.findMany({
    where: { status: "PUBLISHED", ...(club ? { club } : {}) },
    orderBy: { publishedAt: "desc" },
    take: limit,
    select: { id: true, title: true, slug: true, excerpt: true, club: true, publishedAt: true },
  });

  return NextResponse.json({
    articles: articles.map((a) => ({
      id: a.id,
      title: a.title,
      slug: a.slug,
      excerpt: a.excerpt,
      club: a.club,
      publishedAgo: a.publishedAt ? timeAgo(a.publishedAt) : "",
    })),
  });
}

function timeAgo(date: Date): string {
  const minutes = Math.floor((Date.now() - date.getTime()) / 60000);
  if (minutes < 1) return "à l'instant";
  if (minutes < 60) return `il y a ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `il y a ${hours} h`;
  return `il y a ${Math.floor(hours / 24)} j`;
}
