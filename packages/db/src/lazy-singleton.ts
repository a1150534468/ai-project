export function lazySingleton<TArgs extends unknown[], TValue extends object>(
  create: (...args: TArgs) => TValue,
): (...args: TArgs) => TValue {
  let instance: TValue | undefined;

  return (...args) => {
    instance ??= create(...args);
    return instance;
  };
}
