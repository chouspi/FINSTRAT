FROM mcr.microsoft.com/dotnet/sdk:10.0.302 AS build
WORKDIR /src

COPY backend/src/Finstrat.Api/Finstrat.Api.csproj backend/src/Finstrat.Api/
RUN dotnet restore backend/src/Finstrat.Api/Finstrat.Api.csproj

COPY backend/src/Finstrat.Api/ backend/src/Finstrat.Api/
RUN dotnet publish backend/src/Finstrat.Api/Finstrat.Api.csproj \
    --configuration Release \
    --no-restore \
    --output /app/publish

FROM mcr.microsoft.com/dotnet/aspnet:10.0.10-noble-chiseled
WORKDIR /app
COPY --from=build --chown=app:app /app/publish .
COPY --chown=app:app backend/DataProtectionKeys/ /home/app/.aspnet/DataProtection-Keys/
COPY --chown=app:app ["frontend/src/assets/last day I gambled/counter_kokotstvi.txt", "/app/data/counter_kokotstvi.txt"]
EXPOSE 8080
ENTRYPOINT ["dotnet", "Finstrat.Api.dll"]
