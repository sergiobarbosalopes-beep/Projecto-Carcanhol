export type PrePersistenceValidationResult<TModel, TError> =
  { ok: true; models: TModel[] } | { ok: false; code: TError };

export async function persistOnlyAfterValidation<TModel, TError, TValue>({
  validate,
  persist,
}: {
  validate: () => Promise<PrePersistenceValidationResult<TModel, TError>>;
  persist: (models: TModel[]) => Promise<TValue>;
}): Promise<{ ok: true; value: TValue } | { ok: false; code: TError }> {
  const validation = await validate();

  if (!validation.ok) {
    return validation;
  }

  return {
    ok: true,
    value: await persist(validation.models),
  };
}
