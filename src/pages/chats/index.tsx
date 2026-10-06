import { Badge, Input, Card, Empty } from "@/components";
import { useHistory } from "@/hooks";
import { PageLayout } from "@/layouts";
import { MessageCircleIcon, Search } from "lucide-react";
import moment from "moment";
import { useNavigate } from "react-router-dom";

const Dashboard = () => {
  const conversations = useHistory();
  const navigate = useNavigate();
  // Search narrows the list itself; grouping happens on what is left, so a
  // day never shows conversations that do not match.
  const query = conversations.search.trim().toLowerCase();
  const visibleConversations = query
    ? conversations.conversations.filter((doc) =>
        (doc.title || "").toLowerCase().includes(query),
      )
    : conversations.conversations;

  // Group conversations by date
  const groupedConversations = visibleConversations.reduce(
    (acc, doc) => {
      const dateKey = moment(doc.updatedAt).format("YYYY-MM-DD");
      if (!acc[dateKey]) {
        acc[dateKey] = [];
      }
      acc[dateKey].push(doc);
      return acc;
    },
    {} as Record<string, typeof conversations.conversations>
  );

  // Sort dates in descending order (most recent first)
  const sortedDates = Object.keys(groupedConversations).sort((a, b) =>
    moment(b).diff(moment(a))
  );

  return (
    <PageLayout
      title="All conversations"
      description="Every captured session and chat, newest first"
    >
      <>
        {conversations.conversations.length === 0 ? (
          <Empty
            isLoading={conversations.isLoading}
            icon={MessageCircleIcon}
            title="No conversations found"
            description="Start a new conversation to get started"
          />
        ) : (
          <div className="flex flex-col gap-6 pb-8">
            <div className="relative mb-4 w-1/3">
              <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="text"
                placeholder="Search conversations..."
                className="pl-9 focus-visible:ring-0 focus-visible:ring-offset-0"
                value={conversations.search}
                onChange={(e) => conversations.setSearch(e.target.value)}
              />
            </div>
            {sortedDates.length === 0 && (
              <p className="text-sm text-muted-foreground">
                No conversations match “{conversations.search.trim()}”.
              </p>
            )}
            {sortedDates.map((dateKey) => (
                <div key={dateKey} className="flex flex-col gap-3">
                  <p className="text-xs text-muted-foreground select-none font-medium">
                    {moment(dateKey).format("ddd, MMM D")}
                  </p>
                  <div className="grid grid-cols-1 gap-3">
                    {groupedConversations[dateKey].map((doc) => (
                      <Card
                        key={doc.id}
                        className="shadow-none select-none p-4 gap-0 group relative transition-all !bg-secondary/50 hover:!border-primary/50 cursor-pointer"
                        onClick={() => navigate(`/chats/view/${doc.id}`)}
                      >
                        <div className="flex items-center justify-between">
                          <p className="line-clamp-1 text-sm mr-8">
                            {doc.title || "Untitled conversation"}
                          </p>
                          <div className="flex items-center gap-1">
                            <Badge variant="outline" className="text-xs">
                              {doc.messages.length}{" "}
                              {doc.messages.length === 1
                                ? "message"
                                : "messages"}
                            </Badge>
                            <Badge variant="outline" className="text-xs">
                              {moment(doc.updatedAt).format("hh:mm A")}
                            </Badge>
                          </div>
                        </div>
                      </Card>
                    ))}
                  </div>
                </div>
              ))}
          </div>
        )}
      </>
    </PageLayout>
  );
};

export default Dashboard;
