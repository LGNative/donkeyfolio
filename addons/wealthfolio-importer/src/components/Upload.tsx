import React, { useState, useRef, type DragEvent, type ChangeEvent } from 'react';

const ACCEPTED = ['.pdf', '.png', '.jpg', '.jpeg'];
const MAX_SIZE_MB = 20;
const MAX_SIZE_BYTES = MAX_SIZE_MB * 1024 * 1024;

interface UploadProps {
  onFile: (file: File) => void;
  disabled?: boolean;
}

export function Upload({ onFile, disabled }: UploadProps) {
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  function validate(file: File): string | null {
    const ext = '.' + file.name.split('.').pop()?.toLowerCase();
    if (!ACCEPTED.includes(ext) && !['application/pdf', 'image/png', 'image/jpeg'].includes(file.type)) {
      return 'Unsupported file type. Please upload a PDF, PNG, or JPEG.';
    }
    if (file.size > MAX_SIZE_BYTES) {
      return `File too large (${(file.size / 1024 / 1024).toFixed(1)}MB). Max ${MAX_SIZE_MB}MB.`;
    }
    return null;
  }

  function handleFile(file: File) {
    setError('');
    const err = validate(file);
    if (err) { setError(err); return; }
    onFile(file);
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer?.files?.[0];
    if (file) handleFile(file);
  }

  function onChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
  }

  const borderColor = dragging ? 'var(--primary)' : 'var(--border)';

  return (
    <div>
      <div
        onDrop={onDrop}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onClick={() => !disabled && inputRef.current?.click()}
        style={{
          border: `2px dashed ${borderColor}`,
          borderRadius: '8px',
          padding: '40px 20px',
          textAlign: 'center',
          cursor: disabled ? 'not-allowed' : 'pointer',
          opacity: disabled ? 0.5 : 1,
          transition: 'border-color 0.15s',
        }}
      >
        <p style={{ margin: 0, fontWeight: 500 }}>Drop a PDF or image here, or click to browse</p>
        <p style={{ margin: '4px 0 0', fontSize: '12px', color: 'var(--muted-foreground)' }}>
          PDF, PNG, JPEG — up to {MAX_SIZE_MB}MB
        </p>
      </div>
      <input ref={inputRef} type="file" accept={ACCEPTED.join(',')} onChange={onChange} hidden />
      {error && (
        <p style={{ marginTop: '8px', padding: '8px 12px', borderRadius: '6px', background: 'hsl(0 84% 60% / 0.1)', color: 'hsl(0 84% 60%)', fontSize: '13px' }}>
          {error}
        </p>
      )}
    </div>
  );
}
