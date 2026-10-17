import { Routes, Route, NavLink } from 'react-router-dom';
import Home from './pages/Home.jsx';
import SeriesShows from './pages/SeriesShows.jsx';
import Show from './pages/Show.jsx';
import Tracks from './pages/Tracks.jsx';
import Artists from './pages/Artists.jsx';
import Artist from './pages/Artist.jsx';
import Mine from './pages/Mine.jsx';
import Favourites from './pages/Favourites.jsx';

export default function App() {
  return (
    <>
      <header className="top">
        <div className="wrap">
          <span className="brand">Tracklist browser</span>
          <nav>
            <NavLink to="/" end>Sarjad</NavLink>
            <NavLink to="/tracks">Lood</NavLink>
            <NavLink to="/artists">Esitajad</NavLink>
            <NavLink to="/mine">Minu</NavLink>
            <NavLink to="/favourites">Põnev</NavLink>
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
          <Route path="/mine" element={<Mine />} />
          <Route path="/favourites" element={<Favourites />} />
          <Route path="*" element={<p className="empty">Lehte ei leitud.</p>} />
        </Routes>
      </main>
    </>
  );
}
