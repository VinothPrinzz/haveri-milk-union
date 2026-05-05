import { Link, useLocation } from "react-router-dom";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Home } from "lucide-react";

export default function NotFound() {
  const location = useLocation();

  useEffect(() => {
    console.error("404 — unknown route:", location.pathname);
  }, [location.pathname]);

  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] gap-3 p-8">
      <div className="text-[48px] font-semibold text-muted-foreground/50 num">404</div>
      <div className="text-[15px] font-medium">Page not found</div>
      <div className="text-[13px] text-muted-foreground font-mono">{location.pathname}</div>
      <Button asChild size="sm" className="mt-2 h-8 bg-primary hover:bg-primary-hover">
        <Link to="/"><Home className="h-3.5 w-3.5 mr-1.5" /> Go to Dashboard</Link>
      </Button>
    </div>
  );
}