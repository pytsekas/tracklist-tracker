import { Routes, Route, NavLink } from 'react-router-dom';
import Home from './pages/Home.jsx';
import SeriesShows from './pages/SeriesShows.jsx';
import Show from './pages/Show.jsx';
import Tracks from './pages/Tracks.jsx';
import Artists from './pages/Artists.jsx';
import Artist from './pages/Artist.jsx';

export default function App() {
  return (
    <>
      <header className="top">
        <div className="wrap">
          <span className="brand">Tracklist browser</span>
          <nav>
            <NavLink to="/" end>Series</NavLink>
            <NavLink to="/tracks">Tracks</NavLink>
            <NavLink to="/artists">Artists</NavLink>
          </nav>
        </div>
      </header>
      <main className="wrap">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/series/:slug" element={<SeriesShows />} />
          <Route path="/shows/:id" element={<Show />} />
          <Route path="/tracks" element={<Tracks />} />
          <Route path="/artists" element={<Artists />} />
          <Route path="/artists/:id" element={<Artist />} />
          <Route path="*" element={<p className="empty">Not found.</p>} />
        </Routes>
      </main>
    </>
  );
}
