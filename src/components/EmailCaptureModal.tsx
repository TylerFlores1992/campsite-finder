'use client';

import { useState } from 'react';
import { X, Bell, Loader2 } from 'lucide-react';

interface EmailCaptureModalProps {
  onConfirm: (email: string) => void;
  onClose: () => void;
  campgroundName: string;
}

export default function EmailCaptureModal({ onConfirm, onClose, campgroundName }: EmailCaptureModalProps) {
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.includes('@')) { setError('Enter a valid email'); return; }
    setLoading(true);
    setError('');
    try {
      await onConfirm(email);
    } catch {
      setError('Something went wrong, try again');
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm p-6 relative">
        <button
          onClick={onClose}
          className="absolute top-4 right-4 text-gray-400 hover:text-gray-600"
        >
          <X size={18} />
        </button>

        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-full bg-amber-50 flex items-center justify-center">
            <Bell size={20} className="text-amber-600" />
          </div>
          <div>
            <h2 className="font-semibold text-gray-900 text-sm leading-tight">Get notified instantly</h2>
            <p className="text-xs text-gray-500">{campgroundName}</p>
          </div>
        </div>

        <p className="text-sm text-gray-600 mb-4">
          We'll email you the moment a campsite opens up for your dates.
        </p>

        <form onSubmit={handleSubmit} className="space-y-3">
          <input
            type="email"
            placeholder="your@email.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoFocus
            className="w-full px-3 py-2.5 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
          />
          {error && <p className="text-xs text-red-500">{error}</p>}
          <button
            type="submit"
            disabled={loading}
            className="w-full py-2.5 rounded-lg bg-green-600 text-white text-sm font-medium hover:bg-green-700 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {loading ? <Loader2 size={14} className="animate-spin" /> : <Bell size={14} />}
            {loading ? 'Setting up alert…' : 'Notify me when available'}
          </button>
        </form>

        <p className="text-xs text-gray-400 mt-3 text-center">No spam. One email per opening.</p>
      </div>
    </div>
  );
}
