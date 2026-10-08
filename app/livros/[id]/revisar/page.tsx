import { redirect } from "next/navigation";

export default async function ReviewIndex({ params }: { params: Promise<{ id: string }> }) {
  redirect(`/livros/${(await params).id}/revisar/1`);
}
