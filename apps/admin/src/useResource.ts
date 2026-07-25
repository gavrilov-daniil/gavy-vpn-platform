import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage } from "./api";

interface Resource<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
  /** Тихое обновление без состояния загрузки — для автополлинга и локальных правок. */
  setData: (data: T) => void;
}

/**
 * Загрузка данных экрана с тремя честными состояниями.
 * `load` берётся из ref, поэтому его не обязательно мемоизировать; перезапуск — по deps.
 */
export function useResource<T>(load: () => Promise<T>, deps: unknown[] = []): Resource<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);

  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    loadRef
      .current()
      .then((result) => {
        if (cancelled) return;
        setData(result);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(errorMessage(e));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [...deps, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);

  return { data, error, loading, reload, setData };
}
