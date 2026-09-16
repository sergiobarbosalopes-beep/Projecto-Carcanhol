export type PrePersistenceValidationResult<TModel, TQuota, TError> =
  { ok: true; models: TModel[]; quota: TQuota } | { ok: false; code: TError };

export async function persistOnlyAfterValidation<
  TModel,
  TQuota,
  TError,
  TValue,
>({
  validate,
  persist,
}: {
  validate: () => Promise<
    PrePersistenceValidationResult<TModel, TQuota, TError>
  >;
  persist: (models: TModel[], quota: TQuota) => Promise<TValue>;
}): Promise<{ ok: true; value: TValue } | { ok: false; code: TError }> {
  const validation = await validate();

  if (!validation.ok) {
    return validation;
  }

  return {
    ok: true,
    value: await persist(validation.models, validation.quota),
  };
}
