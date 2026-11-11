import com.google.gson.*;
import forge.GuiDesktop;
import forge.StaticData;
import forge.card.GamePieceType;
import forge.card.CardRules;
import forge.LobbyPlayer;
import forge.gui.GuiBase;
import forge.model.FModel;
import forge.ai.*;
import forge.ai.simulation.GameStateEvaluator;
import forge.deck.Deck;
import forge.game.*;
import forge.game.ability.*;
import forge.game.ability.effects.CharmEffect;
import forge.game.card.*;
import forge.game.combat.Combat;
import forge.game.mana.Mana;
import forge.game.phase.PhaseHandler;
import forge.game.player.*;
import forge.game.spellability.*;
import forge.game.trigger.Trigger;
import forge.game.trigger.TriggerType;
import forge.game.trigger.WrappedAbility;
import forge.game.zone.ZoneType;
import forge.util.MyRandom;
import forge.util.collect.FCollectionView;
import java.io.*;
import java.lang.reflect.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.MessageDigest;
import java.util.*;
import java.util.zip.ZipFile;

/** Pinned Forge 2.0.15 adapter. Every simulation rebuilds its root and replays its path;
 * no GameCopier or model-authored state mutations are used in search/continuations. */
public final class EngineWorker {
    static final Gson JSON=new GsonBuilder().disableHtmlEscaping().create();
    static final ZoneType[] ZONES={ZoneType.Hand,ZoneType.Battlefield,ZoneType.Graveyard,ZoneType.Exile,ZoneType.Command};
    static final class Boundary extends RuntimeException { Boundary(){super(null,null,false,false);} }
    static final class InvalidAction extends RuntimeException { InvalidAction(String s){super(s);} }
    static void require(boolean ok,String message){if(!ok)throw new InvalidAction(message);}
    static String str(JsonObject o,String k,String fallback){return o.has(k)&&!o.get(k).isJsonNull()?o.get(k).getAsString():fallback;}
    static int num(JsonObject o,String k,int fallback){return o.has(k)?o.get(k).getAsInt():fallback;}
    static boolean bool(JsonObject o,String k,boolean fallback){return o.has(k)?o.get(k).getAsBoolean():fallback;}
    static void field(Object object,String name,Object value)throws Exception {
        Field f=object.getClass().getDeclaredField(name);f.setAccessible(true);f.set(object,value);
    }
    static final class Loader extends GameState {
        void apply(Game g){super.applyGameOnThread(g);}
        Map<Integer,Card> identities()throws Exception {
            Field f=GameState.class.getDeclaredField("idToCard");f.setAccessible(true);
            return new HashMap<>((Map<Integer,Card>)f.get(this));
        }
    }
    static final class Choice {
        SpellAbility ability;
        JsonObject action;
        Choice(SpellAbility ability,JsonObject action){this.ability=ability;this.action=action;}
    }
    static final class Context {
        Game game;JsonObject root;final Map<Integer,Integer> external=new HashMap<>();
        List<Player> seats;
        List<Object> initialLibraries;
        final List<Object> trace=new ArrayList<>(),executed=new ArrayList<>();final List<JsonObject> decisions=new ArrayList<>();
        JsonObject resolutionChoice,timedCast;
        boolean enumerateChoices,expandChoices,keepExecuted,skipForcedPasses,exhaustive;
        final Set<String> enumerationGaps=new LinkedHashSet<>();
        List<JsonObject> effectMenu;
        List<Choice> priorityMenu;
        final List<Object> priorityWalk=new ArrayList<>();
        int walkTurn=-1,walkPhase=-1;
        int effectActor=-1;
        boolean resolutionChoiceApplied,timedCastApplied;
        JsonArray path;int pathIndex=0,choices=0,step=0,rootTurn=0,viewer=1,maxChoices=400;
        boolean rollout=false,includeTrace=false;Choice pending;int logOffset=0;
        Map<String,Object> lastAction;
        int goalIndex=0,goalsCompleted=0,goalStartedTurn=0;boolean initialExchangeOpen;final List<String> blockedGoals=new ArrayList<>();
        int external(Card c){return external.getOrDefault(c.getId(),2_000_000_000+c.getId());}
        String ref(GameObject object){
            if(object instanceof Player p)return "p:"+seats.indexOf(p);
            if(object instanceof Card c)return "c:"+external(c);
            if(object instanceof SpellAbility sa)return "s:"+external(sa.getHostCard());
            throw new InvalidAction("Unsupported target object");
        }
        GameObject target(String ref){
            if(ref.startsWith("p:"))return game.getPlayers().get(Integer.parseInt(ref.substring(2)));
            if(ref.startsWith("c:")){int id=Integer.parseInt(ref.substring(2));for(Card c:game.getCardsInGame())if(external(c)==id)return c;}
            if(ref.startsWith("s:")){int id=Integer.parseInt(ref.substring(2));for(var si:game.getStack())if(external(si.getSourceCard())==id)return si.getSpellAbility();}
            throw new InvalidAction("Target not present: "+ref);
        }
        void capture(String kind,String label){
            if(!includeTrace)return;
            List<String> logs=new ArrayList<>();List<GameLogEntry> entries=game.getGameLog().getAllEntries();
            for(int i=logOffset;i<entries.size();i++)logs.add(entries.get(i).message());logOffset=entries.size();
            Map<String,Object> projected=snapshot(this);
            if(kind.equals("decision")&&seats.indexOf(game.getPhaseHandler().getPriorityPlayer())==viewer){int version=1_000_000+trace.size();projected.put("pendingAction",Map.of("type","PRIORITY","message","Forge branch decision","promptVersion",version,"cardOptions",List.of(),"min",0,"max",0));projected.put("priorityPromptVersion",version);}
            Map<String,Object> frame=new LinkedHashMap<>();frame.put("kind",kind);frame.put("label",label);frame.put("logs",logs);frame.put("state",projected);
            if(lastAction!=null)frame.put("action",lastAction);trace.add(frame);
        }
        List<JsonObject> goals(){
            List<JsonObject> result=new ArrayList<>();if(!root.has("intent"))return result;
            for(JsonElement e:root.getAsJsonObject("intent").getAsJsonArray("goals"))if(!str(e.getAsJsonObject(),"action","").equals("avoid"))result.add(e.getAsJsonObject());return result;
        }
        JsonObject wanted(){List<JsonObject> goals=goals();return goalIndex<goals.size()?goals.get(goalIndex):null;}
        boolean banned(JsonObject action){
            if(!root.has("intent"))return false;
            for(JsonElement e:root.getAsJsonObject("intent").getAsJsonArray("goals")){
                JsonObject goal=e.getAsJsonObject();if(!str(goal,"action","").equals("avoid")||!str(goal,"cardName","").equals(str(action,"cardName","")))continue;
                String scope=str(goal,"scope","this_turn");
                if(scope.equals("entire_branch")||scope.equals("this_turn")&&game.getPhaseHandler().getTurn()==rootTurn||scope.equals("until_goals_complete")&&wanted()!=null||scope.equals("initial_exchange")&&initialExchangeOpen)return true;
            }
            return false;
        }
        boolean matches(JsonObject action,JsonObject goal){
            if(goal==null||!str(goal,"action","").equals(str(action,"kind","")))return false;
            if(!str(goal,"cardName","").isEmpty()&&!str(goal,"cardName","").equals(str(action,"cardName","")))return false;
            if(!str(goal,"abilityText","").isEmpty()&&!str(action,"label","").toLowerCase(Locale.ROOT).contains(str(goal,"abilityText","").toLowerCase(Locale.ROOT)))return false;
            for(JsonElement desired:goal.getAsJsonArray("modes")){
                boolean matched=false;for(JsonElement actual:action.has("modeDescriptions")?action.getAsJsonArray("modeDescriptions"):new JsonArray())if(actual.getAsString().toLowerCase(Locale.ROOT).contains(desired.getAsString().toLowerCase(Locale.ROOT)))matched=true;
                if(!matched)return false;
            }
            for(JsonElement desired:goal.getAsJsonArray("targets")){
                JsonObject target=desired.getAsJsonObject();boolean matched=false;
                for(JsonElement set:action.has("targets")?action.getAsJsonArray("targets"):new JsonArray())for(JsonElement ref:set.getAsJsonArray()){
                    GameObject object=target(ref.getAsString());String playerId=str(target,"playerId","");
                    if(str(target,"kind","").equals("player")&&object instanceof Player p&&(playerId.isEmpty()||playerId.equals(String.valueOf(seats.indexOf(p)))))matched=true;
                    if(str(target,"kind","").equals("card")&&object instanceof Card card&&str(target,"name","").equals(card.getName())&&(playerId.isEmpty()||playerId.equals(String.valueOf(seats.indexOf(card.getController())))))matched=true;
                }
                if(!matched)return false;
            }
            return true;
        }
        boolean allowed(Choice choice){
            if(num(choice.action,"actorId",-1)!=viewer||!root.has("intent"))return true;
            if(banned(choice.action))return false;JsonObject goal=wanted();if(goal==null||str(choice.action,"kind","").equals("pass"))return true;
            if(matches(choice.action,goal))return true;
            boolean preparation=choice.ability!=null&&(choice.ability.isLandAbility()||choice.ability.getHostCard().isLand()&&choice.ability.getApi()==ApiType.ChangeZone);
            if(!preparation)return false;
            for(int i=goalIndex+1;i<goals().size();i++)if(str(goals().get(i),"cardName","").equals(str(choice.action,"cardName","")))return false;
            return true;
        }
        boolean needsManaPreparation(){
            JsonObject goal=wanted();if(goal==null)return false;
            Player actor=seats.get(viewer);
            for(Card card:ComputerUtilAbility.getAvailableCards(game,actor))if(card.getName().equals(str(goal,"cardName","")))for(SpellAbility ability:card.getSpellAbilities()){
                ability.setActivatingPlayer(actor);
                if(ability.canPlay()&&!ComputerUtilCost.canPayCost(ability,actor,false))return true;
            }
            return false;
        }
        void completed(JsonObject action){if(num(action,"actorId",-1)==viewer&&matches(action,wanted())){goalIndex++;goalsCompleted++;goalStartedTurn=game.getPhaseHandler().getTurn();}}
    }
    static final class Controller extends PlayerControllerAi {
        final Context context;final Player actor;
        Controller(Game g,Player p,LobbyPlayer lp,Context c){super(g,p,lp);actor=p;context=c;getAi().setUseSimulation(null);}
        @Override public List<SpellAbility> chooseSpellAbilityToPlay(){
            if(++context.choices>context.maxChoices)throw new Boundary();
            if(context.game.getStack().isEmpty()||context.game.getPhaseHandler().getTurn()!=context.rootTurn)context.initialExchangeOpen=false;
            long decisionSeed=context.root.get("seed").getAsLong()+0x9e3779b97f4a7c15L*context.choices;
            MyRandom.setRandom(new Random(decisionSeed));
            if(context.walkTurn>=0&&context.pathIndex>=context.path.size()){
                PhaseHandler phase=context.game.getPhaseHandler();
                if(phase.getTurn()>context.walkTurn||phase.getTurn()==context.walkTurn&&phase.getPhase().ordinal()>context.walkPhase)
                    throw new Boundary();
                List<Choice> choices=candidates(context,actor);
                Choice pass=choices.stream().filter(choice->choice.ability==null).findFirst().orElseThrow();
                context.priorityWalk.add(Map.of("state",snapshot(context),"advance",pass.action,"hasAlternatives",choices.size()>1));
                return null;
            }
            List<Choice> menu=null;
            if(context.skipForcedPasses&&(!context.rollout||context.pathIndex<context.path.size())){
                menu=candidates(context,actor);
                if(menu.size()==1&&menu.get(0).ability==null)return null;
            }
            if(context.pathIndex<context.path.size()){
                JsonObject action=context.path.get(context.pathIndex++).getAsJsonObject();
                require(num(action,"actorId",-1)==context.game.getPlayers().indexOf(actor),"Path actor does not have priority");
                if(str(action,"kind","").equals("pass")){context.decisions.add(action);context.completed(action);return null;}
                String key=str(action,"key","");Choice selected=null;
                for(Choice c:menu==null?candidates(context,actor):menu)if(str(c.action,"key","").equals(key)){selected=c;break;}
                require(selected!=null,"Path action is no longer available: "+str(action,"label",key));
                context.pending=selected;context.decisions.add(selected.action);return List.of(selected.ability);
            }
            if(!context.rollout){context.priorityMenu=menu;throw new Boundary();}
            if(context.timedCast!=null&&!context.timedCastApplied&&context.seats.indexOf(actor)==context.viewer&&
                context.game.getPhaseHandler().getTurn()==num(context.timedCast,"turn",-1)){
                String phase=context.game.getPhaseHandler().getPhase().name();
                if(!phase.equals(str(context.timedCast,"phase","")))return null;
                for(Choice option:candidates(context,actor)){
                    if(str(option.action,"kind","").equals("cast")&&str(option.action,"cardName","").equals("Show and Tell")&&
                        num(option.action,"cardId",-1)==num(context.timedCast,"sourceId",-2)){
                        context.pending=option;context.decisions.add(option.action);return List.of(option.ability);
                    }
                }
                return null;
            }
            if(context.seats.indexOf(actor)==context.viewer&&context.wanted()!=null){
                if(context.game.getPhaseHandler().getTurn()>context.goalStartedTurn+2){context.blockedGoals.add(str(context.wanted(),"cardName","")+": unavailable after opponent responses / two turns");context.goalIndex++;context.goalStartedTurn=context.game.getPhaseHandler().getTurn();}
                if(context.wanted()!=null){
                    List<Choice> options=candidates(context,actor);Choice selected=null;
                    for(Choice option:options)if(context.matches(option.action,context.wanted())){selected=option;break;}
                    if(selected==null&&str(context.wanted(),"timing","").equals("at_start"))
                        throw new InvalidAction("Requested action unavailable at start: "+str(context.wanted(),"cardName",str(context.wanted(),"action","")));
                    if(selected==null&&context.game.getStack().isEmpty()&&context.needsManaPreparation())for(Choice option:options)if(option.ability!=null&&context.allowed(option)){selected=option;break;}
                    if(selected==null||selected.ability==null){JsonObject pass=new JsonObject();pass.addProperty("actorId",context.viewer);pass.addProperty("kind","pass");context.completed(pass);return null;}
                    context.pending=selected;context.decisions.add(selected.action);MyRandom.setRandom(new Random(decisionSeed));return List.of(selected.ability);
                }
            }
            // Native rollout policy can replan both players at every priority opportunity.
            List<SpellAbility> selected=super.chooseSpellAbilityToPlay();
            MyRandom.setRandom(new Random(decisionSeed));
            if(context.seats.indexOf(actor)==context.viewer&&selected!=null&&!selected.isEmpty()){
                JsonObject action=new JsonObject();action.addProperty("cardName",selected.get(0).getHostCard().getName());if(context.banned(action))return null;
            }
            if(selected!=null&&selected.size()>1)return new ArrayList<>(selected.subList(0,1));
            return selected;
        }
        @Override public <T extends GameEntity> T chooseSingleEntityForEffect(FCollectionView<T> options,DelayedReveal reveal,
                SpellAbility ability,String title,boolean optional,Player related,Map<String,Object> params){
            if(ability!=null&&ability.getHostCard().getName().equals("Atraxa, Grand Unifier")){
                List<T> selected=searchEffectChoice(options,ability,optional?0:1,1);
                if(selected!=null)return selected.isEmpty()?null:selected.get(0);
            }
            return super.chooseSingleEntityForEffect(options,reveal,ability,title,optional,related,params);
        }
        private <T extends GameEntity> List<T> searchEffectChoice(Iterable<T> options,SpellAbility ability,int min,int max){
            if(!context.enumerateChoices||min<0||max>2||max<min)return null;
            List<T> cards=new ArrayList<>();
            for(T option:options)if(option instanceof Card)cards.add(option);else return null;
            if(cards.size()<min||cards.isEmpty())return null;
            JsonObject next=context.pathIndex<context.path.size()?context.path.get(context.pathIndex).getAsJsonObject():null;
            if(!context.expandChoices&&(next==null||!str(next,"kind","").equals("choice")))return null;
            List<List<T>> picks=new ArrayList<>();
            if(min==0)picks.add(List.of());
            if(min<=1&&max>=1)for(T card:cards)picks.add(List.of(card));
            if(max==2)for(int i=0;i<cards.size();i++)for(int j=i+1;j<cards.size();j++)picks.add(List.of(cards.get(i),cards.get(j)));
            int seat=context.seats.indexOf(actor),sourceId=context.external(ability.getHostCard());
            List<JsonObject> menu=new ArrayList<>();
            for(List<T> selection:picks){
                List<Integer> ids=selection.stream().map(c->context.external((Card)c)).toList();
                String key="choice:"+seat+":"+sourceId+":"+ids;
                if(next!=null&&str(next,"key","").equals(key)){
                    context.pathIndex++;context.decisions.add(next);
                    if(context.includeTrace)context.capture("choice",ability.getHostCard().getName()+" → "+selection.stream().map(GameEntity::getName).toList());
                    return selection;
                }
                JsonObject action=new JsonObject();
                action.addProperty("key",key);action.addProperty("kind","choice");action.addProperty("actorId",seat);
                action.addProperty("cardId",sourceId);action.addProperty("cardName",ability.getHostCard().getName());
                action.addProperty("label",ability.getHostCard().getName()+" → "+selection.stream().map(GameEntity::getName).toList());
                menu.add(action);
            }
            if(next!=null)throw new InvalidAction("Recorded effect selection is not available");
            context.effectMenu=menu;context.effectActor=seat;
            throw new Boundary();
        }
        private <T extends GameEntity> List<T> forcedChoice(Iterable<T> options,SpellAbility ability,String name,int min,int max){
            JsonObject choice=context.resolutionChoice;
            if(choice==null||context.resolutionChoiceApplied||context.seats.indexOf(actor)!=context.viewer||
                !name.equals(str(choice,"name",""))||!name.equals(ability.getHostCard().getName())||
                context.external(ability.getHostCard())!=num(choice,"sourceId",-1))return null;
            List<T> selected=new ArrayList<>();
            Set<Integer> ids=new HashSet<>();
            for(JsonElement e:choice.getAsJsonArray("ids")){
                int id=e.getAsInt();require(ids.add(id),"Duplicate resolution choice");
                T found=null;
                for(T option:options)if(option instanceof Card card&&context.external(card)==id){found=option;break;}
                if(found==null)return null;
                selected.add(found);
            }
            if(selected.size()<min||selected.size()>max)return null;
            context.resolutionChoiceApplied=true;
            if(context.includeTrace)context.capture("choice","Chose "+selected.stream().map(GameEntity::getName).toList()+" for "+name);
            return selected;
        }
        @Override public <T extends GameEntity> List<T> chooseEntitiesForEffect(FCollectionView<T> options,int min,int max,DelayedReveal reveal,
                SpellAbility ability,String title,Player related,Map<String,Object> params){
            List<T> selected=forcedChoice(options,ability,"Stock Up",min,max);
            if(selected==null&&ability.getHostCard().getName().equals("Stock Up"))
                selected=searchEffectChoice(options,ability,min,max);
            return selected!=null?selected:super.chooseEntitiesForEffect(options,min,max,reveal,ability,title,related,params);
        }
        @Override public Card chooseSingleCardForZoneChange(ZoneType destination,List<ZoneType> origin,SpellAbility ability,CardCollection options,
                DelayedReveal reveal,String title,boolean optional,Player related){
            if(destination==ZoneType.Battlefield&&origin.contains(ZoneType.Hand)&&
                List.of("Sneak Attack","Show and Tell").contains(ability.getHostCard().getName())){
                List<Card> selection=searchEffectChoice(options,ability,optional?0:1,1);
                if(selection!=null)return selection.isEmpty()?null:selection.get(0);
            }
            List<Card> selected=destination==ZoneType.Battlefield&&origin.contains(ZoneType.Hand)?
                forcedChoice(options,ability,"Show and Tell",optional?0:1,1):null;
            return selected!=null?(selected.isEmpty()?null:selected.get(0)):super.chooseSingleCardForZoneChange(destination,origin,ability,options,reveal,title,optional,related);
        }
        @Override public List<AbilitySub> chooseModeForAbility(SpellAbility sa,List<AbilitySub> options,int min,int max,boolean repeat){
            Choice forced=context.pending;
            if(forced!=null&&forced.action.has("modes")&&forced.action.getAsJsonArray("modes").size()>0){
                List<AbilitySub> chosen=new ArrayList<>();
                for(JsonElement e:forced.action.getAsJsonArray("modes")){int i=e.getAsInt();require(i>=0&&i<options.size(),"Mode index changed");chosen.add(options.get(i));}
                require(chosen.size()>=min&&chosen.size()<=max,"Invalid number of modes");return chosen;
            }
            return super.chooseModeForAbility(sa,options,min,max,repeat);
        }
        @Override public boolean playChosenSpellAbility(SpellAbility sa){
            require(sa.canPlay(),"Forge rejected action timing: "+sa.getHostCard().getName());
            String label=sa.getHostCard().getName(),kind=sa.isLandAbility()?"play_land":sa.isSpell()?"cast":"activate";boolean success;
            context.capture("decision",label);
            int lifeBefore=actor.getLife();List<Card> beforeUntapped=new ArrayList<>();if(context.includeTrace)for(Card card:actor.getCardsIn(ZoneType.Battlefield))if(!card.isTapped())beforeUntapped.add(card);
            Choice forced=context.pending;
            SpellAbility[] actualAbility={sa};
            if(sa.isLandAbility()){sa.resolve();success=true;}
            else success=ComputerUtil.handlePlayingSpellAbility(actor,sa,actual->{actualAbility[0]=actual;if(forced!=null)applyTargets(context,actual,forced.action);});
            context.pending=null;
            require(success,"Forge rejected payment or choices: "+label);
            if(forced!=null)context.completed(forced.action);
            if(context.timedCast!=null&&context.seats.indexOf(actor)==context.viewer&&sa.isSpell()&&label.equals("Show and Tell")&&
                context.external(sa.getHostCard())==num(context.timedCast,"sourceId",-1)&&context.game.getPhaseHandler().getTurn()==num(context.timedCast,"turn",-2)&&
                context.game.getPhaseHandler().getPhase().name().equals(str(context.timedCast,"phase","")))context.timedCastApplied=true;
            context.executed.add(Map.of("turn",context.game.getPhaseHandler().getTurn(),"actorId",context.seats.indexOf(actor),"kind",kind,"cardName",label,"description",actualAbility[0].getStackDescription()));
            if(context.includeTrace){
                SpellAbility actual=actualAbility[0];Map<String,Object> action=new LinkedHashMap<>();
                action.put("actorId",context.seats.indexOf(actor));action.put("kind",kind);action.put("cardName",label);action.put("cardId",context.external(actual.getHostCard()));
                action.put("description",actual.getStackDescription());action.put("modes",actual.getChosenList()==null?List.of():actual.getChosenList().stream().map(SpellAbility::getDescription).toList());
                List<Object> mana=new ArrayList<>();for(Mana paid:actual.getPayingMana())mana.add(Map.of("sourceId",context.external(paid.getSourceCard()),"sourceName",paid.getSourceCard().getName(),"color",forge.card.MagicColor.toShortString(paid.getColor())));
                action.put("manaPaid",mana);action.put("lifeBefore",lifeBefore);action.put("lifeAfterPayment",actor.getLife());action.put("lifeCost",actual.getAmountLifePaid());
                List<Object> paidCards=new ArrayList<>();for(var cell:actual.getPaidHash().cellSet()){
                    List<Object> cards=new ArrayList<>();for(Card card:cell.getValue())cards.add(Map.of("id",context.external(card),"name",card.getName()));
                    if(!cards.isEmpty())paidCards.add(Map.of("kind",cell.getRowKey(),"cards",cards));
                }
                action.put("paidCards",paidCards);
                List<Object> tapped=new ArrayList<>();for(Card card:beforeUntapped)if(card.isTapped())tapped.add(Map.of("cardId",context.external(card),"name",card.getName()));action.put("tappedSources",tapped);
                context.lastAction=action;context.capture("action",label);context.lastAction=null;
            }
            return true;
        }
    }
    static Context restore(JsonObject root,boolean includeLibraries)throws Exception {
        Context c=new Context();c.root=root;c.viewer=num(root,"viewerId",1);
        MyRandom.setRandom(new Random(root.get("seed").getAsLong()));
        List<RegisteredPlayer> registered=new ArrayList<>();
        JsonArray names=root.getAsJsonArray("names");
        for(int i=0;i<2;i++){
            Deck deck=new Deck("search-"+i);
            if(root.has("decks"))for(JsonElement entry:root.getAsJsonArray("decks").get(i).getAsJsonObject().getAsJsonArray("main")){
                JsonObject card=entry.getAsJsonObject();deck.getMain().add(card.get("name").getAsString(),card.get("count").getAsInt());
            }
            registered.add(new RegisteredPlayer(deck).setPlayer(new LobbyPlayerAi(names.get(i).getAsString(),Collections.emptySet())));
        }
        GameRules rules=new GameRules(GameType.Constructed);rules.setGamesPerMatch(1);
        Match match=new Match(rules,registered,"Forge search branch");
        c.game=new Game(registered,rules,match);c.game.setNoGUIUser();c.game.setAge(GameStage.Play);
        c.seats=new ArrayList<>(c.game.getPlayers());
        Loader loader=new Loader();loader.parse(Arrays.asList(str(root,"stateText","").split("\\r?\\n")));loader.apply(c.game);
        for(var entry:loader.identities().entrySet())c.external.put(entry.getValue().getId(),entry.getKey());
        if(root.has("impending")){
            for(JsonElement id:root.getAsJsonArray("impending")){
                Card card=(Card)c.target("c:"+id.getAsInt());
                SpellAbility cast=card.getFirstSpellAbility().copy(card.getController());
                cast.setAlternativeCost(AlternativeCost.Impending);card.setCastSA(cast);
            }
            c.game.getAction().checkStaticAbilities();
        }
        if(root.has("tokens"))for(JsonElement entry:root.getAsJsonArray("tokens")){
            JsonObject original=entry.getAsJsonObject();for(Card card:c.game.getCardsInGame())if(c.external(card)==num(original,"id",-1)){
                require(card.getName().equals("Thundertrap Trainer"),"Unrestored replica token");card.setGamePieceType(GamePieceType.TOKEN);card.setBasePower(1);card.setBaseToughness(1);
            }
        }
        if(root.has("statuses"))for(int i=0;i<c.seats.size();i++){
            Player p=c.seats.get(i);JsonObject status=root.getAsJsonArray("statuses").get(i).getAsJsonObject();
            if(bool(status,"hasMonarch",false)){c.game.setMonarch(p);p.createMonarchEffect("CN2");}
            if(bool(status,"hasInitiative",false)){c.game.setHasInitiative(p);p.createInitiativeEffect("CLB");}
            if(bool(status,"hasCitysBlessing",false))p.setBlessing(true,"RIX");
            if(status.has("companion")){
                JsonObject proof=status.getAsJsonObject("companion");
                Card companion=p.getCardsIn(ZoneType.Command).stream().filter(card->
                    c.external(card)==num(proof,"id",-1)&&card.getName().equals(str(proof,"name",""))).findFirst().orElse(null);
                require(companion!=null&&!companion.getKeywords(forge.game.keyword.Keyword.COMPANION).isEmpty(),"Missing recorded companion");
                var effect=Player.createCompanionEffect(companion);
                p.getZone(ZoneType.Command).add(effect);
            }
            for(JsonElement original:status.getAsJsonArray("commandEffects")){
                JsonObject effect=original.getAsJsonObject();Card restored=null;
                for(Card card:p.getCardsIn(ZoneType.Command))if(card.getName().equals(str(effect,"name",""))){restored=card;break;}
                if(restored==null)restored=restoreAdventure(p,str(effect,"name",""));
                require(restored!=null,"Unrestored continuous command effect: "+str(effect,"name",""));c.external.put(restored.getId(),num(effect,"id",-1));
            }
        }
        restoreStack(c);
        if(root.has("cardHistory"))for(var entry:root.getAsJsonObject("cardHistory").entrySet()){
            int sourceId=Integer.parseInt(entry.getKey());JsonObject history=entry.getValue().getAsJsonObject();
            for(Card card:c.game.getCardsInGame())if(c.external(card)==sourceId){
                if(history.has("turnInZone"))card.setTurnInZone(history.get("turnInZone").getAsInt());
                for(int n=0;n<num(history,"planeswalkerActivations",0);n++)card.addPlaneswalkerAbilityActivated();
            }
        }
        c.rootTurn=c.game.getPhaseHandler().getTurn();c.goalStartedTurn=c.rootTurn;c.initialExchangeOpen=!c.game.getStack().isEmpty();
        for(int i=0;i<2;i++){
            Player p=c.game.getPlayers().get(i);JsonObject h=root.getAsJsonArray("history").get(i).getAsJsonObject();
            for(String name:List.of("numDrawnThisTurn","numDrawnThisDrawStep","numExtraDrawnThisTurn","numDrawnLastTurn"))field(p,name,num(h,name,0));
            p.setLifeStartedThisTurnWith(num(h,"lifeStartedThisTurn",p.getLife()));
            p.setLifeLostThisTurn(num(h,"lifeLostThisTurn",0));p.setLifeGainedThisTurn(num(h,"lifeGainedThisTurn",0));
            field(p,"spellsCastThisGame",num(h,"spellsCastThisGame",0));p.setSpellsCastLastTurn(num(h,"spellsCastLastTurn",0));
            p.dangerouslySetController(new Controller(c.game,p,registered.get(i).getPlayer(),c));
        }
        PhaseHandler ph=c.game.getPhaseHandler();
        if(root.has("combat")){
            Combat combat=new Combat(ph.getPlayerTurn());
            for(JsonElement entry:root.getAsJsonObject("combat").getAsJsonArray("attackers")){
                JsonObject attack=entry.getAsJsonObject();
                Card attacker=(Card)c.target("c:"+num(attack,"card",-1));
                int defender=num(attack,"defender",0);
                combat.addAttacker(attacker,(GameEntity)c.target(defender<0?"p:"+(-defender-1):"c:"+defender));
                if(attack.has("blocked")&&!attack.get("blocked").isJsonNull())combat.setBlocked(attacker,attack.get("blocked").getAsBoolean());
            }
            ph.setCombat(combat);
        }
        if(root.has("spellHistory")){
            c.game.getStack().getSpellsCastThisTurn().clear();c.game.getStack().getSpellsCastLastTurn().clear();
            for(JsonElement entry:root.getAsJsonArray("spellHistory")){
                JsonObject record=entry.getAsJsonObject();Player p=c.seats.get(record.get("playerId").getAsInt());Card card=null;
                for(Card found:c.game.getCardsInGame())if(c.external(found)==num(record,"cardId",Integer.MIN_VALUE)){card=found;break;}
                if(card==null){var paper=StaticData.instance().getCommonCards().getCard(record.get("cardName").getAsString());require(paper!=null,"Missing cast-history card");card=Card.fromPaperCard(paper,p);}
                SpellAbility ability=card.getFirstSpellAbility().copy(p);ability.setActivatingPlayer(p);
                if(num(record,"turn",0)==c.rootTurn)c.game.getStack().getSpellsCastThisTurn().add(ability);
                else c.game.getStack().getSpellsCastLastTurn().add(card);
            }
        }
        ph.setPriority(c.game.getPlayers().get(num(root,"firstPriorityId",num(root,"activePlayerId",0))));
        field(ph,"pPlayerPriority",c.game.getPlayers().get(num(root,"priorityPlayerId",0)));
        field(ph,"givePriorityToPlayer",true);
        c.initialLibraries=new ArrayList<>();if(includeLibraries)for(Player p:c.seats){List<Object> library=new ArrayList<>();for(Card card:p.getCardsIn(ZoneType.Library))library.add(Map.of("id",c.external(card),"name",card.getName()));c.initialLibraries.add(library);}
        c.game.copyLastState();c.logOffset=c.game.getGameLog().getAllEntries().size();
        return c;
    }
    static Card restoreAdventure(Player player,String effectName){
        // Match the public Adventure permission to a unique exiled card's Adventure face.
        if(!effectName.matches(".+ \\(\\d+\\)'s Adventure")||effectName.matches(".*[|$\\r\\n].*"))return null;
        String adventureName=effectName.substring(0,effectName.lastIndexOf(" ("));
        List<Card> matches=player.getCardsIn(ZoneType.Exile).stream().filter(card->card.isAdventureCard()&&
            card.getOwner()==player&&card.getState(forge.card.CardStateName.Secondary).getName().equals(adventureName)).toList();
        if(matches.size()!=1)return null;
        Card card=matches.get(0);
        // The same permission as GameState's OnAdventure loader, preserving the recorded effect name.
        SpellAbility ability=AbilityFactory.getAbility("DB$ Effect | RememberObjects$ Self | StaticAbilities$ Play | ForgetOnMoved$ Exile | Duration$ Permanent | Name$ "+effectName,card);
        ability.setSVar("Play","Mode$ Continuous | MayPlay$ True | EffectZone$ Command | Affected$ Card.IsRemembered+!Adventure | AffectedZone$ Exile | Description$ You may cast the card.");
        ability.setActivatingPlayer(player);
        ability.resolve();
        card.setExiledWith(card);card.setExiledBy(player);
        return player.getCardsIn(ZoneType.Command).stream().filter(effect->effect.getName().equals(effectName)).findFirst().orElse(null);
    }
    static void restoreAcererakTrigger(Context c,JsonObject entry,JsonObject original,Player player){
        require(str(original,"name","").equals("Acererak the Archlich")
            && str(entry,"sourceCardZone","").equals("Battlefield")
            && str(entry,"abilityDescription","").startsWith("When Acererak the Archlich enters,")
            && !bool(entry,"optionalTrigger",false)
            && (!entry.has("targets")||entry.getAsJsonArray("targets").isEmpty()),"Unsupported root trigger");
        int sourceId=num(original,"id",-1);
        Card host=null;
        for(Card card:player.getCardsIn(ZoneType.Battlefield))if(c.external(card)==sourceId){host=card;break;}
        require(host!=null&&host.getName().equals("Acererak the Archlich"),"Missing Acererak trigger source");
        require(player.getCompletedDungeons().isEmpty(),"Unrestored dungeon progress");
        Trigger trigger=null;
        for(Trigger candidate:host.getTriggers())if(candidate.getMode()==TriggerType.ChangesZone){
            require(trigger==null,"Ambiguous Acererak enter trigger");trigger=candidate;
        }
        require(trigger!=null&&!trigger.isStatic(),"Missing Acererak enter trigger");
        SpellAbility template=trigger.getOverridingAbility();
        SpellAbility ability=template==null?AbilityFactory.getAbility(host,trigger.getParam("Execute")):template.copy(host,player,false,true);
        require(ability!=null&&!ability.usesTargeting(),"Unexpected Acererak enter trigger");
        ability.setActivatingPlayer(player);
        ability.setTrigger(trigger);
        Map<AbilityKey,Object> params=AbilityKey.mapFromCard(host);
        params.put(AbilityKey.CardLKI,host);
        params.put(AbilityKey.Origin,ZoneType.Stack);
        params.put(AbilityKey.Destination,ZoneType.Battlefield);
        trigger.setTriggeringObjects(ability,params);
        c.game.getStack().addAndUnfreeze(new WrappedAbility(trigger,ability,null));
    }
    static void restoreStack(Context c){
        if(!c.root.has("stack")||c.root.getAsJsonArray("stack").isEmpty())return;
        c.game.getTriggerHandler().setSuppressAllTriggers(true);
        try{
            JsonArray stack=c.root.getAsJsonArray("stack");
            for(int i=stack.size()-1;i>=0;i--){
                JsonObject entry=stack.get(i).getAsJsonObject();
                JsonObject original=entry.getAsJsonObject("sourceCard");Player player=c.seats.get(Integer.parseInt(str(entry,"controllerId",str(original,"controllerId","0"))));
                if(bool(entry,"isTrigger",false)){restoreAcererakTrigger(c,entry,original,player);continue;}
                require(!bool(entry,"isAbility",false),"Unrestored stack ability");
                var paper=StaticData.instance().getCommonCards().getCard(original.get("name").getAsString());require(paper!=null,"Missing stack card");
                Card card=Card.fromPaperCard(paper,player);c.external.put(card.getId(),original.get("id").getAsInt());
                SpellAbility sa=card.getFirstSpellAbility();sa.setActivatingPlayer(player);
                require(!sa.costHasManaX(),"Root stack X value is not yet restored");
                if(sa.getApi()==ApiType.Charm){
                    String description=str(entry,"abilityDescription","").toLowerCase(Locale.ROOT).replaceAll("[^a-z0-9]","");
                    List<AbilitySub> selected=new ArrayList<>();
                    for(AbilitySub option:CharmEffect.makePossibleOptions(sa)){
                        String mode=option.getDescription().toLowerCase(Locale.ROOT).replaceAll("[^a-z0-9]","");
                        if(!mode.isEmpty()&&description.contains(mode))selected.add(option);
                    }
                    require(!selected.isEmpty(),"Cannot restore stack modes");CharmEffect.chainAbilities(sa,selected);
                }
                JsonArray remaining=entry.getAsJsonArray("targets")==null?new JsonArray():entry.getAsJsonArray("targets").deepCopy();
                for(SpellAbility part:parts(sa))if(part.usesTargeting()){
                    for(int t=0;t<remaining.size();t++){
                        JsonObject target=remaining.get(t).getAsJsonObject();String zone=str(target,"zone","");int id=num(target,"id",Integer.MIN_VALUE);GameObject object=null;
                        if(zone.equals("Player"))object=c.seats.get(id<0?-id-1:Integer.parseInt(str(target,"ownerId",String.valueOf(id))));
                        else if(zone.equals("Stack")){for(var item:c.game.getStack())if(c.external(item.getSourceCard())==id){object=item.getSpellAbility();break;}}
                        else for(Card candidate:c.game.getCardsInGame())if(c.external(candidate)==id){object=candidate;break;}
                        if(object==null)continue;
                        if(!canTarget(part,object))continue;
                        if(object instanceof Player p)part.getTargets().add(p);else if(object instanceof Card cardTarget)part.getTargets().add(cardTarget);else part.getTargets().add((SpellAbility)object);
                        remaining.remove(t--);if(part.isMaxTargetChosen())break;
                    }
                    require(part.isTargetNumberValid(),"Cannot restore stack targets");
                }
                require(remaining.isEmpty(),"Unassigned original stack target");
                Card onStack=c.game.getAction().moveToStack(card,sa);sa.setHostCard(onStack);c.external.put(onStack.getId(),original.get("id").getAsInt());
                c.game.getStack().addAndUnfreeze(sa);
            }
        }finally{c.game.getTriggerHandler().setSuppressAllTriggers(false);}
    }
    static Map<String,Object> card(Context ctx,Card card,boolean hide){
        Map<String,Object> c=new LinkedHashMap<>();
        c.put("id",ctx.external(card));c.put("name",hide?"Hidden card":card.getName());
        c.put("zone",card.getZone()==null?"Command":card.getZone().getZoneType().toString());
        if(card.getZone()!=null&&card.getZone().getZoneType()==ZoneType.Command&&ctx.root.has("statuses")){
            JsonObject status=ctx.root.getAsJsonArray("statuses").get(ctx.seats.indexOf(card.getOwner())).getAsJsonObject();
            if(status.has("companion")&&ctx.external(card)==num(status.getAsJsonObject("companion"),"id",-1))c.put("isCompanion",true);
        }
        c.put("ownerId",String.valueOf(ctx.seats.indexOf(card.getOwner())));
        c.put("controllerId",String.valueOf(ctx.seats.indexOf(card.getController())));
        c.put("tapped",card.isTapped());c.put("faceDown",hide||card.isFaceDown());c.put("isToken",card.isToken());
        c.put("hasSummoningSickness",card.hasSickness());c.put("power",hide?0:card.getNetPower());c.put("toughness",hide?0:card.getNetToughness());
        c.put("damage",card.getDamage());c.put("manaCost",hide?"":card.getManaCost().toString());c.put("cmc",hide?0:card.getManaCost().getCMC());
        c.put("oracleText",hide?"":card.getOracleText());
        c.put("types",hide?List.of():card.getType().getCoreTypes().stream().map(Object::toString).toList());
        c.put("subtypes",hide?List.of():card.getType().getSubtypes());
        c.put("supertypes",hide?List.of():card.getType().getSupertypes().stream().map(Object::toString).toList());
        Map<String,Integer> counters=new LinkedHashMap<>();for(var e:card.getCounters().entrySet())counters.put(e.getElement().toString(),e.getCount());
        c.put("counters",counters);List<String> keywords=new ArrayList<>();for(var keyword:card.getKeywords())keywords.add(keyword.getOriginal());c.put("keywords",hide?List.of():keywords);c.put("color",hide?"C":card.getColor().toString());
        if(card.isPlaneswalker())c.put("loyalty",card.getCurrentLoyalty());
        c.put("isAttacking",ctx.game.getCombat()!=null&&ctx.game.getCombat().isAttacking(card));c.put("isBlocking",ctx.game.getCombat()!=null&&ctx.game.getCombat().isBlocking(card));c.put("isTransformed",card.isTransformed());c.put("isBackFace",card.isTransformed());
        if(ctx.game.getCombat()!=null&&ctx.game.getCombat().isAttacking(card)){
            GameEntity defender=ctx.game.getCombat().getDefenderByAttacker(card);
            if(defender instanceof Player p)c.put("attackingDefenderId",-1-ctx.seats.indexOf(p));
            else if(defender instanceof Card target)c.put("attackingDefenderId",ctx.external(target));
        }
        c.put("isPhasedOut",card.isPhasedOut());c.put("attachedCards",List.of());
        if(!card.getNamedCard().isEmpty())c.put("chosenMarks",List.of(Map.of("kind","NAME","value",card.getNamedCard())));
        return c;
    }
    static Map<String,Object> snapshot(Context c){
        Game g=c.game;Map<String,Object> s=new LinkedHashMap<>();
        s.put("gameId",str(c.root,"gameId","forge-search"));s.put("turnNumber",g.getPhaseHandler().getTurn());
        s.put("phase",g.getPhaseHandler().getPhase().toString());s.put("step",g.getPhaseHandler().getPhase().toString());
        s.put("activePlayerId",String.valueOf(g.getPlayers().indexOf(g.getPhaseHandler().getPlayerTurn())));
        s.put("priorityPlayerId",String.valueOf(g.getPlayers().indexOf(g.getPhaseHandler().getPriorityPlayer())));
        s.put("status",g.isGameOver()?"COMPLETE":"ACTIVE");s.put("pendingAction",null);s.put("sequenceNumber",c.step++);s.put("isDay",g.isDay());s.put("isNight",g.isNight());s.put("stormCount",g.getStack().getSpellsCastThisTurn().size());
        List<Object> players=new ArrayList<>();
        for(Player p:c.seats){
            Map<String,Object> out=new LinkedHashMap<>();int seat=c.seats.indexOf(p);
            out.put("id",String.valueOf(seat));out.put("name",p.getName());out.put("life",p.getLife());
            out.put("handSize",p.getCardsIn(ZoneType.Hand).size());out.put("librarySize",p.getCardsIn(ZoneType.Library).size());
            Map<String,Integer> mana=new LinkedHashMap<>();for(Mana m:p.getManaPool())mana.merge(forge.card.MagicColor.toShortString(m.getColor()),1,Integer::sum);out.put("manaPool",mana);
            out.put("drawnThisTurn",p.getNumDrawnThisTurn());out.put("landsPlayedThisTurn",p.getLandsPlayedThisTurn());
            out.put("spellsCastThisTurn",p.getSpellsCastThisTurn());
            out.put("hasLostGame",p.hasLost());out.put("hasConceded",false);
            out.put("hasMonarch",p.isMonarch());out.put("hasInitiative",p.hasInitiative());out.put("hasCitysBlessing",p.hasBlessing());out.put("hasEnduringStory",p.hasEnduringStory());
            out.put("poisonCounters",p.getPoisonCounters());out.put("energyCounters",p.getCounters(CounterType.getType("ENERGY")));out.put("experienceCounters",p.getCounters(CounterType.getType("EXPERIENCE")));out.put("radCounters",p.getCounters(CounterType.getType("RAD")));out.put("ringTempts",p.getNumRingTemptedYou());
            for(ZoneType zone:ZONES){List<Object> cards=new ArrayList<>();for(Card card:p.getCardsIn(zone))cards.add(card(c,card,false));out.put(zone==ZoneType.Command?"commandZone":zone.toString().toLowerCase(),cards);}
            players.add(out);
        }
        s.put("players",players);List<Object> stack=new ArrayList<>();
        for(var si:g.getStack()){
            SpellAbility sa=si.getSpellAbility();Map<String,Object> out=new LinkedHashMap<>();
            out.put("id",si.getId());out.put("name",sa.getHostCard().getName());out.put("description",sa.getStackDescription());out.put("abilityDescription",sa.getStackDescription());
            out.put("controllerId",String.valueOf(g.getPlayers().indexOf(sa.getActivatingPlayer())));out.put("sourceCard",card(c,sa.getHostCard(),false));
            out.put("isAbility",!sa.isSpell());out.put("isTrigger",sa.isTrigger());out.put("sourceCardZone",sa.getHostCard().getZone()==null?"Command":sa.getHostCard().getZone().getZoneType().toString());out.put("stackTargetId",-1_000_000-si.getId());
            List<Object> targets=new ArrayList<>();
            for(SpellAbility part:parts(sa))for(GameObject target:part.getTargets()){
                if(target instanceof Card card)targets.add(Map.of("id",c.external(card),"zone",card.getZone()==null?"Command":card.getZone().getZoneType().toString(),"ownerId",String.valueOf(c.seats.indexOf(card.getOwner()))));
                else if(target instanceof Player player)targets.add(Map.of("id",-c.seats.indexOf(player)-1,"zone","Player","ownerId",String.valueOf(c.seats.indexOf(player))));
                else if(target instanceof SpellAbility ability)targets.add(Map.of("id",c.external(ability.getHostCard()),"zone","Stack","ownerId",String.valueOf(c.seats.indexOf(ability.getActivatingPlayer()))));
            }
            out.put("targets",targets);stack.add(out);
        }
        s.put("stack",stack);
        if(g.isGameOver()&&g.getOutcome()!=null){RegisteredPlayer winner=g.getOutcome().getWinningPlayer();if(winner!=null)s.put("winnerId",String.valueOf(g.getMatch().getPlayers().indexOf(winner)));}
        return s;
    }
    static List<SpellAbility> parts(SpellAbility sa){
        List<SpellAbility> result=new ArrayList<>();for(SpellAbility a=sa;a!=null;a=a.getSubAbility())result.add(a);return result;
    }
    static boolean canTarget(SpellAbility ability,GameObject target){
        if(target instanceof SpellAbility stackItem)return ability.getTargetRestrictions().getZone().contains(ZoneType.Stack)&&ability.canTargetSpellAbility(stackItem);
        return ability.canTarget(target);
    }
    static void applyTargets(Context ctx,SpellAbility sa,JsonObject action){
        JsonArray targets=action.getAsJsonArray("targets");List<SpellAbility> chain=parts(sa);
        for(int i=0;i<chain.size();i++){
            SpellAbility part=chain.get(i);if(!part.usesTargeting())continue;part.resetTargets();
            JsonArray selected=i<targets.size()?targets.get(i).getAsJsonArray():new JsonArray();
            for(JsonElement e:selected){GameObject object=ctx.target(e.getAsString());
                require(canTarget(part,object),"Forge rejected target: "+e.getAsString());
                if(object instanceof Player p)part.getTargets().add(p);else if(object instanceof Card c)part.getTargets().add(c);else part.getTargets().add((SpellAbility)object);
            }
            require(part.isTargetNumberValid(),"Forge rejected target count");
        }
    }
    static List<GameObject> targetOptions(Context ctx,SpellAbility sa,Player actor){
        List<GameObject> objects=new ArrayList<>();objects.addAll(ctx.game.getPlayers());
        for(ZoneType zone:List.of(ZoneType.Battlefield,ZoneType.Graveyard,ZoneType.Exile,ZoneType.Command))for(Card c:ctx.game.getCardsIn(zone))if(!c.isFaceDown())objects.add(c);
        for(Card c:actor.getCardsIn(ZoneType.Hand))objects.add(c);
        for(var si:ctx.game.getStack())objects.add(si.getSpellAbility());
        objects.removeIf(o->{try{return !canTarget(sa,o);}catch(Exception e){return true;}});
        return objects;
    }
    static void targetProducts(Context ctx,Player p,SpellAbility sa,List<SpellAbility> chain,int index,JsonArray targetSets,List<Choice> output,JsonObject description,int limit){
        if(output.size()>=limit)return;
        if(index==chain.size()){
            JsonObject action=description.deepCopy();action.add("targets",targetSets.deepCopy());
            action.addProperty("key",action.get("actorId").getAsString()+"/"+action.get("cardId").getAsString()+"/"+action.get("abilityIndex").getAsString()+"/"+action.get("modes")+"/"+targetSets+"/"+action.get("x"));
            SpellAbility prepared=sa.copy(p);applyTargets(ctx,prepared,action);output.add(new Choice(prepared,action));return;
        }
        SpellAbility part=chain.get(index);
        if(!part.usesTargeting()){
            targetSets.add(new JsonArray());targetProducts(ctx,p,sa,chain,index+1,targetSets,output,description,limit);targetSets.remove(targetSets.size()-1);return;
        }
        int min=part.getMinTargets();
        if(ctx.exhaustive){
            List<GameObject> options=targetOptions(ctx,part,p);
            targetSelections(ctx,p,sa,chain,index,targetSets,output,description,options,new ArrayList<>(),min,part.getMaxTargets());
            return;
        }
        if(min>1)return; // Fast search uses single-target choices.
        List<GameObject> options=targetOptions(ctx,part,p);
        if(min==0){targetSets.add(new JsonArray());targetProducts(ctx,p,sa,chain,index+1,targetSets,output,description,limit);targetSets.remove(targetSets.size()-1);}
        for(GameObject o:options){
            JsonArray selected=new JsonArray();selected.add(ctx.ref(o));targetSets.add(selected);
            targetProducts(ctx,p,sa,chain,index+1,targetSets,output,description,limit);targetSets.remove(targetSets.size()-1);
            if(output.size()>=limit)break;
        }
    }
    static void targetSelections(Context ctx,Player p,SpellAbility sa,List<SpellAbility> chain,int index,JsonArray targetSets,
            List<Choice> output,JsonObject description,List<GameObject> options,List<GameObject> selected,int min,int max){
        if(selected.size()>=min){
            JsonArray refs=new JsonArray();
            for(GameObject option:selected)refs.add(ctx.ref(option));
            targetSets.add(refs);
            try{targetProducts(ctx,p,sa,chain,index+1,targetSets,output,description,Integer.MAX_VALUE);}
            catch(InvalidAction error){ctx.enumerationGaps.add(error.getMessage());}
            finally{targetSets.remove(targetSets.size()-1);}
        }
        if(selected.size()>=max)return;
        for(GameObject option:options)if(!selected.contains(option)){
            selected.add(option);
            targetSelections(ctx,p,sa,chain,index,targetSets,output,description,options,selected,min,max);
            selected.remove(selected.size()-1);
        }
    }
    static List<Choice> candidates(Context ctx,Player p){
        List<Choice> result=new ArrayList<>();int actor=ctx.game.getPlayers().indexOf(p);
        List<SpellAbility> all=ComputerUtilAbility.getOriginalAndAltCostAbilities(ComputerUtilAbility.getSpellAbilities(ComputerUtilAbility.getAvailableCards(ctx.game,p),p),p);
        Map<Integer,Integer> indices=new HashMap<>();
        for(SpellAbility original:all){
            int id=ctx.external(original.getHostCard()),index=indices.merge(id,1,Integer::sum)-1;
            if(original.isManaAbility())continue;
            try{
                original.setActivatingPlayer(p);if(!original.canPlay())continue;
                List<List<Integer>> modeSets=new ArrayList<>();modeSets.add(new ArrayList<>());
                if(original.getApi()==ApiType.Charm){
                    modeSets.clear();List<AbilitySub> options=CharmEffect.makePossibleOptions(original);
                    int min=AbilityUtils.calculateAmount(original.getHostCard(),original.getParamOrDefault("MinCharmNum",original.getParamOrDefault("CharmNum","1")),original);
                    int max=AbilityUtils.calculateAmount(original.getHostCard(),original.getParamOrDefault("CharmNum","1"),original);
                    if(ctx.exhaustive&&(max>2||original.hasParam("CanRepeatModes")))ctx.enumerationGaps.add("Unexpanded modal combinations: "+original.getHostCard().getName());
                    for(int i=0;i<options.size();i++){if(min<=1&&max>=1)modeSets.add(new ArrayList<>(List.of(i)));if(min<=2&&max>=2)for(int j=i+1;j<options.size();j++)modeSets.add(new ArrayList<>(List.of(i,j)));}
                }
                if(ctx.exhaustive&&original.costHasManaX())ctx.enumerationGaps.add("Unexpanded X values: "+original.getHostCard().getName());
                for(List<Integer> modes:modeSets)for(int x:original.costHasManaX()?new int[]{0,1,2,3,5}:new int[]{-1}){
                    SpellAbility sa=original.copy(p);if(x>=0)sa.setXManaCostPaid(x);
                    if(!modes.isEmpty()){
                        List<AbilitySub> options=CharmEffect.makePossibleOptions(sa),chosen=new ArrayList<>();for(int m:modes)chosen.add(options.get(m));CharmEffect.chainAbilities(sa,chosen);
                    }
                    if(!ComputerUtilCost.canPayCost(sa,p,false))continue;
                    JsonObject action=new JsonObject();action.addProperty("actorId",actor);action.addProperty("cardId",id);action.addProperty("abilityIndex",index);
                    action.addProperty("kind",sa.isLandAbility()?"play_land":sa.isSpell()?"cast":"activate");
                    action.addProperty("cardName",sa.getHostCard().getName());action.addProperty("label",sa.getHostCard().getName()+" — "+sa.toString());
                    action.addProperty("manaCost",sa.getHostCard().getManaCost().toString());action.addProperty("x",x);action.add("modes",JSON.toJsonTree(modes));
                    action.add("modeDescriptions",JSON.toJsonTree(sa.getChosenList()==null?List.of():sa.getChosenList().stream().map(SpellAbility::getDescription).toList()));
                    targetProducts(ctx,p,sa,parts(sa),0,new JsonArray(),result,action,ctx.exhaustive?Integer.MAX_VALUE:Math.min(80,result.size()+8));
                    if(!ctx.exhaustive&&result.size()>=80)break;
                }
            }catch(Exception error){
                if(ctx.exhaustive)ctx.enumerationGaps.add("Candidate adapter: "+original.getHostCard().getName()+" / "+error);
            }
            if(!ctx.exhaustive&&result.size()>=80)break;
        }
        JsonObject pass=new JsonObject();pass.addProperty("kind","pass");pass.addProperty("actorId",actor);pass.addProperty("key","pass:"+actor);pass.addProperty("label","Pass priority");
        result.add(new Choice(null,pass));result.removeIf(choice->!ctx.allowed(choice));return result;
    }
    static Map<String,Object> evaluation(Context c){
        Game game=c.game;double score=0;List<Object> features=new ArrayList<>();
        for(int i=0;i<c.seats.size();i++){
            Player p=c.seats.get(i);double board=0;
            for(Card card:p.getCardsIn(ZoneType.Battlefield)){
                if(card.isLand())board+=35;
                else if(card.isCreature())board+=new CreatureEvaluator().evaluateCreature(card);
                else board+=45+card.getManaCost().getCMC()*22+card.getCounters().size()*12;
            }
            double value=board+p.getCardsIn(ZoneType.Hand).size()*45+p.getLife()*2;
            if(p.hasLost())value=-1_000_000;
            score+=(i==c.viewer?1:-1)*value;
            features.add(Map.of("playerId",i,"life",p.getLife(),"handSize",p.getCardsIn(ZoneType.Hand).size(),"boardValue",board));
        }
        return Map.of("score",score,"features",features,"kind","public-material-heuristic","isWinProbability",false);
    }
    static JsonObject catalog(JsonObject request){
        JsonObject result=new JsonObject();JsonArray cards=new JsonArray();
        for(JsonElement name:request.getAsJsonArray("names")){
            var paper=StaticData.instance().getCommonCards().getCard(name.getAsString());
            if(paper==null){JsonObject missing=new JsonObject();missing.addProperty("name",name.getAsString());missing.addProperty("found",false);cards.add(missing);continue;}
            var rules=paper.getRules();JsonObject card=new JsonObject();card.addProperty("name",name.getAsString());card.addProperty("found",true);
            card.addProperty("canonicalName",paper.getName());card.addProperty("manaCost",rules.getManaCost().toString());card.addProperty("type",rules.getType().toString());
            card.addProperty("oracleText",rules.getOracleText());card.addProperty("land",rules.getType().isLand());cards.add(card);
        }
        result.add("cards",cards);return result;
    }
    static int winnerSeat(Context c){
        if(!c.game.isGameOver()||c.game.getOutcome()==null)return -1;
        RegisteredPlayer winner=c.game.getOutcome().getWinningPlayer();
        return winner==null?-1:c.game.getMatch().getPlayers().indexOf(winner);
    }
    static JsonObject execute(JsonObject request)throws Exception {
        if(str(request,"command","").equals("catalog"))return catalog(request);
        boolean simulate=str(request,"command","expand").equals("simulate");
        boolean searchProbe=bool(request,"searchProbe",false)&&!bool(request,"includeTrace",false);
        Context c=restore(request.getAsJsonObject("root"),!searchProbe);
        c.exhaustive=bool(request,"exhaustive",false);
        if(str(request,"command","").equals("walk-priority")){
            c.walkTurn=num(request,"throughTurn",-1);
            c.walkPhase=forge.game.phase.PhaseType.valueOf(str(request,"throughPhase","")).ordinal();
            require(c.walkTurn>=c.rootTurn&&c.walkTurn<=c.rootTurn+1,"Priority walk must end within one turn of its root");
        }
        c.enumerateChoices=bool(request,"enumerateChoices",false);
        c.expandChoices=c.enumerateChoices&&!simulate;
        c.keepExecuted=bool(request,"includeExecuted",false);
        c.skipForcedPasses=!simulate&&bool(request,"skipForcedPasses",false)||bool(request,"skipForcedPasses",false)&&request.has("path");
        c.timedCast=request.has("timedCast")?request.getAsJsonObject("timedCast"):null;
        c.resolutionChoice=request.has("resolutionChoice")?request.getAsJsonObject("resolutionChoice"):null;
        c.path=request.has("path")?request.getAsJsonArray("path"):new JsonArray();c.includeTrace=bool(request,"includeTrace",false);
        c.maxChoices=c.exhaustive?Integer.MAX_VALUE:Math.min(8000,Math.max(1,num(request,"maxChoices",400)));
        int maxSteps=c.exhaustive?Integer.MAX_VALUE:Math.min(12000,Math.max(1,num(request,"maxSteps",800)));
        int horizon=Math.min(100,Math.max(0,num(request,"horizonTurns",2)));
        c.rollout=false;c.capture("root","Restored and audited search root");String stopped="decision";
        int steps=0;
        while(!c.game.isGameOver()&&steps++<maxSteps){
            try{c.game.getPhaseHandler().mainLoopStep();c.capture("priority","Priority / phase / stack");}
            catch(Boundary boundary){
                if(c.pathIndex<c.path.size())throw new InvalidAction("Path exceeded decision budget");
                if(!simulate||c.choices>c.maxChoices){stopped=c.choices>c.maxChoices?"choice_budget":"decision";break;}
                c.rollout=true;c.priorityMenu=null;
            }
            if(c.pathIndex>=c.path.size()&&c.rollout&&c.game.getPhaseHandler().getTurn()>=c.rootTurn+horizon){stopped="horizon";break;}
            if(c.includeTrace&&c.trace.size()>4000){stopped="trace_budget";break;}
        }
        require(c.pathIndex==c.path.size(),"Path did not complete before cutoff");
        if(c.game.isGameOver())stopped="game_over";else if(steps>=maxSteps)stopped="step_budget";
        c.capture("end",stopped);
        JsonObject output=new JsonObject();
        int winner=winnerSeat(c);
        if(c.walkTurn>=0){output.add("windows",JSON.toJsonTree(c.priorityWalk));return output;}
        if(searchProbe&&simulate){
            JsonObject state=new JsonObject();
            state.addProperty("status",c.game.isGameOver()?"COMPLETE":"ACTIVE");
            state.addProperty("turnNumber",c.game.getPhaseHandler().getTurn());
            if(winner>=0)state.addProperty("winnerId",String.valueOf(winner));
            output.add("state",state);
        }else{
            Map<String,Object> state=snapshot(c);
            if(c.effectActor>=0)state.put("priorityPlayerId",String.valueOf(c.effectActor));
            output.add("state",JSON.toJsonTree(state));
        }
        if(simulate||!searchProbe)output.add("evaluation",JSON.toJsonTree(evaluation(c)));
        if(!searchProbe)output.add("rootLibraries",JSON.toJsonTree(c.initialLibraries));
        if(c.timedCast!=null)output.addProperty("timedCastApplied",c.timedCastApplied);
        if(c.resolutionChoice!=null)output.addProperty("resolutionChoiceApplied",c.resolutionChoiceApplied);
        output.addProperty("stopReason",stopped);output.addProperty("choices",c.choices);output.addProperty("engineSteps",steps);
        if(!searchProbe){
            output.add("decisions",JSON.toJsonTree(c.decisions));output.add("trace",JSON.toJsonTree(c.trace));
        }
        if(!searchProbe||c.keepExecuted||simulate&&winner==c.viewer)output.add("executed",JSON.toJsonTree(c.executed));
        output.add("intentStatus",JSON.toJsonTree(Map.of("completed",c.goalsCompleted,"total",c.goals().size(),"blocked",c.blockedGoals)));
        List<JsonObject> actions=new ArrayList<>();
        if(c.effectMenu!=null)actions.addAll(c.effectMenu);
        else if(stopped.equals("decision"))for(Choice choice:c.priorityMenu==null?candidates(c,c.game.getPhaseHandler().getPriorityPlayer()):c.priorityMenu)actions.add(choice.action);
        if(c.exhaustive)output.add("enumerationGaps",JSON.toJsonTree(c.enumerationGaps));
        output.add("actions",JSON.toJsonTree(actions));return output;
    }
    static String applyRaptorRules()throws Exception {
        Path archive=Path.of("res","cardsfolder","cardsfolder.zip");
        if(!Files.isRegularFile(archive))return "runtime";
        byte[] raw;
        try(ZipFile zip=new ZipFile(archive.toFile())){
            var entry=zip.getEntry("a/amped_raptor.txt");
            if(entry==null)return "runtime";
            try(InputStream input=zip.getInputStream(entry)){raw=input.readAllBytes();}
        }
        var digest=MessageDigest.getInstance("SHA-256");
        if(!HexFormat.of().formatHex(digest.digest(raw)).equals("7eab9bed8039ca91e1340351c0f51bcbc16ccbf2e7692dc62ad02fddf537b0ca"))return "runtime";

        // Freeze the from-hand condition when the trigger is created. Checking it
        // at resolution reads the new object if Raptor left the battlefield.
        List<String> patched=new ArrayList<>();
        for(String line:new String(raw,StandardCharsets.UTF_8).lines().toList()){
            if(line.startsWith("T:Mode$ ChangesZone")){
                patched.add(line.replace("Card.Self","Card.Self+wasCastFromYourHandByYou"));
                patched.add(line.replace("Card.Self","Card.Self+!wasCastFromYourHandByYou")
                    .replace("Execute$ TrigEnergy","Execute$ TrigEnergyOnly"));
            }else if(line.startsWith("SVar:TrigEnergy:")){
                patched.add(line);
                patched.add(line.replace("SVar:TrigEnergy:","SVar:TrigEnergyOnly:").replace(" | SubAbility$ DBDigUntil",""));
            }else{
                patched.add(line.replace(" | ConditionDefined$ TriggeredCard | ConditionPresent$ Card.wasCastFromYourHandByYou",""));
            }
        }
        byte[] bytes=(String.join("\n",patched)+"\n").getBytes(StandardCharsets.UTF_8);
        require(HexFormat.of().formatHex(digest.digest(bytes)).equals("8111ba468341a5711a1da47f34e22fec1cddc776b47b938772d1326ee5aeb3a4"),
            "Unexpected Amped Raptor rules override");
        var card=StaticData.instance().getCommonCards().getCard("Amped Raptor");
        var reinitialize=CardRules.class.getDeclaredMethod("reinitializeFromRules",CardRules.class);
        reinitialize.setAccessible(true);
        reinitialize.invoke(card.getRules(),CardRules.fromScript(patched));
        return "raptor-source-v1";
    }
    public static void main(String[] args)throws Exception {
        PrintStream protocol=System.out;System.setOut(System.err);System.setProperty("java.awt.headless","true");
        GuiBase.setInterface(new GuiDesktop());FModel.initialize(null,null);
        String rules=applyRaptorRules();
        protocol.println(JSON.toJson(Map.of("ready",true,"engine",args.length>0?args[0]:"unknown","rules",rules)));protocol.flush();
        BufferedReader input=new BufferedReader(new InputStreamReader(System.in,StandardCharsets.UTF_8));String line;
        while((line=input.readLine())!=null){
            JsonObject response=new JsonObject();
            try{JsonObject request=JsonParser.parseString(line).getAsJsonObject();response.add("id",request.get("id"));response.addProperty("ok",true);response.add("result",execute(request));}
            catch(Throwable error){response.addProperty("ok",false);response.addProperty("error",error.getClass().getSimpleName()+": "+String.valueOf(error.getMessage()));error.printStackTrace(System.err);}
            protocol.println(JSON.toJson(response));protocol.flush();
        }
    }
}
