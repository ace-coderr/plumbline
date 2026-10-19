import { Route, Routes } from "react-router-dom";
import { Layout, BareLayout } from "./components/Layout";
import { MarketsPage } from "./pages/Markets";
import { MarketPage } from "./pages/Market";
import { MakerPage } from "./pages/Maker";
import { CampaignsPage } from "./pages/Campaigns";
import { NewCampaignPage } from "./pages/NewCampaign";
import { CampaignPage } from "./pages/Campaign";
import { ReportPage } from "./pages/Report";
import { EconomicsPage } from "./pages/Economics";
import { NotFound } from "./pages/NotFound";

export function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<MarketsPage />} />
        <Route path="/market/:pair" element={<MarketPage />} />
        <Route path="/maker" element={<MakerPage />} />
        <Route path="/campaigns" element={<CampaignsPage />} />
        <Route path="/campaigns/new" element={<NewCampaignPage />} />
        <Route path="/campaign/:id" element={<CampaignPage />} />
        <Route path="/economics" element={<EconomicsPage />} />
        <Route path="*" element={<NotFound />} />
      </Route>
      <Route element={<BareLayout />}>
        <Route path="/report/:token" element={<ReportPage />} />
      </Route>
    </Routes>
  );
}
