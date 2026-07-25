interface Props {
  error: string;
  onRetry?: () => void;
}

export default function ErrorBox({ error, onRetry }: Props) {
  return (
    <div className="errorbox">
      <span className="errorbox-text">Ошибка: {error}</span>
      {onRetry && (
        <button type="button" className="btn btn-sm" onClick={onRetry}>
          Повторить
        </button>
      )}
    </div>
  );
}
