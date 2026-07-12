'use client';

// Catches errors thrown in the root layout itself. Must render its own
// <html>/<body> because it replaces the whole document on failure.
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          minHeight: '100vh',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '1rem',
          fontFamily: 'system-ui, sans-serif',
          background: '#F3EFE0',
          textAlign: 'center',
          padding: '1rem',
        }}
      >
        <h1 style={{ fontSize: '1.5rem', fontWeight: 800, color: '#166534' }}>
          CampHawk hit an error
        </h1>
        <p style={{ color: '#4b5563', maxWidth: '24rem' }}>
          Something went wrong loading the app. Please try again.
        </p>
        <button
          onClick={reset}
          style={{
            padding: '0.75rem 1.5rem',
            borderRadius: '1rem',
            background: '#16a34a',
            color: 'white',
            fontWeight: 600,
            border: 'none',
            cursor: 'pointer',
          }}
        >
          Try again
        </button>
      </body>
    </html>
  );
}
