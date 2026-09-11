import { PageHeading } from "@/src/components/page-heading";

export function EmptyFeature({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="mx-auto max-w-6xl">
      <PageHeading title={title} description={description} />
      <section className="flex min-h-64 items-center justify-center rounded-2xl border border-dashed border-slate-300 bg-white px-6 py-12 text-center">
        <div className="max-w-md">
          <div
            className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-teal-50 text-xl font-bold text-teal-800"
            aria-hidden="true"
          >
            ···
          </div>
          <h2 className="mt-4 text-lg font-bold text-slate-900">
            Funcionalidade ainda não disponível
          </h2>
          <p className="mt-2 text-sm leading-6 text-slate-600">
            Esta área está preparada e protegida, mas será implementada numa
            fase posterior do projeto.
          </p>
        </div>
      </section>
    </div>
  );
}
