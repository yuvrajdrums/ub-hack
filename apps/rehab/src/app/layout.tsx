import "@ui/theme.css";
export const metadata = {
  title: "Panda · Rehab",
  description: "A standalone camera-to-text exercise demonstration with estimated movement feedback.",
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header><a className="brand" href="/rehab">panda<span>care</span></a><nav aria-label="Exercise navigation"><a href="/rehab">Exercise</a><a href="#history">Saved history</a></nav><small>Yuvraj · Rehab</small></header>
        <div className="notice">Demonstration references · Camera measurements are estimates · Not connected to a healthcare provider</div>
        <main>{children}</main>
        <footer>Camera-to-text demonstration · No microphone or speech required</footer>
      </body>
    </html>
  );
}
