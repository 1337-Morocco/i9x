// Placeholder cards shown while a service list is loading, so the panel never
// flashes an empty "nothing here yet" state before the real data arrives.
export function CardSkeletons({ n = 2 }: { n?: number }) {
  return (
    <>
      {Array.from({ length: n }, (_, i) => (
        <div className="wp-card skel" key={i} aria-hidden>
          <div className="wp-card-h">
            <div className="skel-bar" style={{ width: '46%', height: 15 }} />
            <div className="skel-bar" style={{ width: 58, height: 18, borderRadius: 999 }} />
          </div>
          <div className="skel-bar" style={{ width: '62%', height: 12, marginTop: 10 }} />
          <div className="skel-bar" style={{ width: '40%', height: 11, marginTop: 8 }} />
          <div className="wp-card-actions">
            {[0, 1, 2].map((k) => <div className="skel-bar" key={k} style={{ width: 30, height: 27, borderRadius: 8 }} />)}
          </div>
        </div>
      ))}
    </>
  )
}
