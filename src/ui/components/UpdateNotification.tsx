import { useState, useEffect } from 'react'
import { api } from '../electronApi.js'

interface UpdateStatus {
  status: 'available' | 'downloading' | 'downloaded'
  version?: string
  percent?: number
  releaseUrl?: string
}

const btnStyle: React.CSSProperties = {
  background: 'var(--pixel-green)',
  color: '#000',
  border: 'none',
  padding: '2px 8px',
  fontSize: '20px',
  cursor: 'pointer',
  fontFamily: 'inherit',
}

const dismissBtnStyle: React.CSSProperties = {
  background: 'none',
  border: 'none',
  color: 'var(--pixel-close-text)',
  cursor: 'pointer',
  padding: '0 2px',
  fontSize: '22px',
  lineHeight: 1,
  fontFamily: 'inherit',
}

export function UpdateNotification() {
  const [update, setUpdate] = useState<UpdateStatus | null>(null)
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    return api.on('updateStatus', (data: unknown) => {
      const status = data as UpdateStatus
      setUpdate(status)
      if (status.status === 'downloaded' || status.releaseUrl) {
        setDismissed(false)
      }
    })
  }, [])

  if (!update || dismissed) return null

  // On macOS (no auto-install): show when releaseUrl is present (status=available)
  // On Windows/Linux (auto-install): show during download progress and when ready
  const isMacNotify = update.status === 'available' && !!update.releaseUrl
  const isAutoUpdate = update.status === 'downloading' || update.status === 'downloaded'

  if (!isMacNotify && !isAutoUpdate) return null

  return (
    <div
      style={{
        position: 'absolute',
        top: 8,
        right: 8,
        zIndex: 200,
        background: 'var(--pixel-bg)',
        border: '2px solid var(--pixel-border-light)',
        padding: '6px 10px',
        boxShadow: 'var(--pixel-shadow)',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        fontSize: '20px',
        color: 'var(--pixel-text)',
      }}
    >
      {/* macOS: notify-only with download link */}
      {isMacNotify && (
        <>
          <span>v{update.version} available!</span>
          <button onClick={() => api.send('openReleaseUrl')} style={btnStyle}>
            Download
          </button>
          <button onClick={() => setDismissed(true)} style={dismissBtnStyle}>
            x
          </button>
        </>
      )}

      {/* Windows/Linux: auto-download progress */}
      {update.status === 'downloading' && (
        <span>Updating... {Math.round(update.percent ?? 0)}%</span>
      )}

      {/* Windows/Linux: ready to install */}
      {update.status === 'downloaded' && (
        <>
          <span>v{update.version} ready!</span>
          <button onClick={() => api.send('installUpdate')} style={btnStyle}>
            Restart
          </button>
          <button onClick={() => setDismissed(true)} style={dismissBtnStyle}>
            x
          </button>
        </>
      )}
    </div>
  )
}
