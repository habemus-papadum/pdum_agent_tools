export function Icon(props: {kind: string}) {
  const paths: Record<string, string> = {
    user:'M8 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6M2 15v-2a6 4 0 0 1 12 0v2',
    assistant:'m8 1 2 5 5 2-5 2-2 5-2-5-5-2 5-2Z',
    command:'m2 4 4 4-4 4m6 0h6', file:'M4 1h5l4 4v10H3V1h1m5 0v4h4M5 8h6M5 11h5',
    tool:'m2 14 7-7M9 7a4 4 0 0 1 0-5l1 3 3 1 2-2a4 4 0 0 1-6 3ZM1 13l2 2',
    thinking:'M5 12h6M6 15h4M5 10C0 5 5 1 8 1s8 4 3 9',
    image:'M1 2h14v12H1ZM2 12l4-5 3 3 2-2 3 4M11 4v1',
    diagram:'M1 1h5v4H1ZM10 11h5v4h-5ZM3 5v8h7M10 1h5v4h-5ZM6 3h4',
    math:'M12 2H4l5 6-5 6h8', error:'m8 1 7 13H1ZM8 5v4M8 11v1',
    compaction:'m2 2 6 5 6-5M2 14l6-5 6 5', agent:'M8 1v6M2 10V7h12v3M1 11h3v4H1Zm11 0h3v4h-3ZM6 11h4v4H6Z',
    related:'M4 1v10a3 3 0 0 0 6 0V5M2 1h4M8 3l2 2 2-2',
    map:'M1 2l4-1 6 2 4-1v12l-4 1-6-2-4 1ZM5 1v12M11 3v12',
    raw:'m5 3-4 5 4 5m6-10 4 5-4 5M9 1 7 15',
    sleep:'M14 10A6 6 0 0 1 6 2a6 6 0 1 0 8 8Z',
    background:'M1 2h14v12H1ZM1 5h14M3 10h2l2-3 2 5 2-2h2',
    event:'m8 1 7 7-7 7-7-7ZM8 5v4M8 11v1',
  };
  return <svg class="history-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d={paths[props.kind] || paths.tool}/></svg>;
}
