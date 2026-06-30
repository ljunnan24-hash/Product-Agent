import { notFound } from "next/navigation";
import { VariantShell } from "@/components/VariantShell";
import { getVariant, variants } from "@/lib/variants";

type Props = {
  params: Promise<{ variant: string }>;
};

export default async function VariantPage({ params }: Props) {
  const { variant: id } = await params;

  if (!(id in variants)) {
    notFound();
  }

  return <VariantShell variant={getVariant(id)} />;
}
