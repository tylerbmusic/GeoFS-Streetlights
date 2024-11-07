// ==UserScript==
// @name         GeoFS Streetlights
// @version      0.1
// @description  Uses OSM to add street lights on the edges of roads
// @author       GGamerGGuy
// @match        https://geo-fs.com/geofs.php*
// @match        https://*.geo-fs.com/geofs.php*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=geo-fs.com
// @grant        none
// ==/UserScript==
const workerScript = () => {
    // Function to interpolate points between two coordinates
    function interpolatePoints(coord1, coord2, distance) {
        const [lat1, lon1] = coord1;
        const [lat2, lon2] = coord2;

        const dLat = lat2 - lat1;
        const dLon = lon2 - lon1;
        const segmentLength = Math.sqrt(dLat * dLat + dLon * dLon);
        const numPoints = Math.ceil(segmentLength / distance);

        const interpolatedPoints = [];
        for (let i = 0; i <= numPoints; i++) {
            const t = i / numPoints;
            const lat = lat1 + t * dLat;
            const lon = lon1 + t * dLon;
            interpolatedPoints.push([lat, lon]);
        }
        return interpolatedPoints;
    }

    // Function to calculate the offset position for streetlights
    function offsetCoordinate(coord, angle, offsetDistance) {
        const [lat, lon] = coord;
        const earthRadius = 6371000; // Earth radius in meters

        const offsetLat = lat + (offsetDistance / earthRadius) * (180 / Math.PI) * Math.cos(angle);
        const offsetLon = lon + (offsetDistance / earthRadius) * (180 / Math.PI) * Math.sin(angle) / Math.cos(lat * Math.PI / 180);

        return [offsetLat, offsetLon];
    }
    const updateRoads = async function(coords) {
        var allSPos = [];
        coords.forEach(road => {
            for (let i = 0; i < road.length - 1; i++) {
                const segmentStart = road[i];
                const segmentEnd = road[i + 1];

                // Calculate angle of the segment for orientation
                const angle = Math.atan2(segmentEnd[1] - segmentStart[1], segmentEnd[0] - segmentStart[0]);

                const interpolatedPoints = interpolatePoints(segmentStart, segmentEnd, 60 / 111000); // 60 meters, converted to degrees

                interpolatedPoints.forEach(point => {
                    // Offset points to the left and right of the road centerline
                    const leftPoint = offsetCoordinate(point, angle + Math.PI / 2, 5); // 5 meters to the left
                    const rightPoint = offsetCoordinate(point, angle - Math.PI / 2, 5); // 5 meters to the right
                    var shouldSendL = true;
                    var shouldSendR = true;
                    for (var i in allSPos) {
                        if ((Math.abs(leftPoint[0] - allSPos[i][0]) < (5/111000)) && (Math.abs(leftPoint[1] - allSPos[i][1]) < (5/111000))) {
                            shouldSendL = false;
                        }
                        if ((Math.abs(rightPoint[0] - allSPos[i][0]) < (5/111000)) && (Math.abs(rightPoint[1] - allSPos[i][1]) < (5/111000))) {
                            shouldSendR = false;
                        }
                        if (!shouldSendL && !shouldSendR) {
                            break;
                        }
                    }

                    // Add streetlights at the left point
                    //console.log([leftPoint, rightPoint]);
                    if (shouldSendL) {
                        allSPos.push(leftPoint);
                        self.postMessage({type: "addStreetlight", data: [leftPoint, angle]});
                    }

                    // Add streetlights at the right point
                    if (shouldSendR) {
                        allSPos.push(rightPoint);
                        self.postMessage({type: "addStreetlight", data: [rightPoint, angle + Math.PI]});
                    }
                });
            }
        });
    };
    // Worker thread (in worker.js)
    function calculateDistance(coord1, coord2) {
        const [lat1, lon1] = coord1;
        const [lat2, lon2] = coord2;
        const earthRadius = 6371000; // Earth radius in meters

        const dLat = (lat2 - lat1) * (Math.PI / 180);
        const dLon = (lon2 - lon1) * (Math.PI / 180);

        const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon / 2) ** 2;

        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

        return earthRadius * c;
    }

    function removeCloseLights(lights) {
        var removeIndices = [];
        var removedIndices = new Set();

        for (var i = 0; i < lights.length; i++) {
            if (!removedIndices.has(i)) {
                for (var j = i + 1; j < lights.length; j++) {
                    var distLat = Math.abs(lights[j][0][0] - lights[i][0][0]);
                    var distLon = Math.abs(lights[j][0][1] - lights[i][0][1]);
                    if ((distLat < (5/111111) && distLon < (5/111111)) && !removedIndices.has(j)) {
                        removeIndices.push(lights[j][1]);
                        removedIndices.add(j);
                    }
                }
            }
        }

        console.log("Removing " + removeIndices.length + " streetlights...");
        return removeIndices;
    }


    ///
    // Function to extract coordinates from OSM data. It also filters out nodes that are too close together.
    function extractCoordinates(data) {
        const nodes = new Map();

        // Extract nodes with their coordinates
        data.elements.forEach(element => {
            if (element.type === 'node') {
                nodes.set(element.id, [element.lat, element.lon]);
            }
        });
        // Extract ways and their coordinates
        const roads = [];
        const filteredCoordinates = [];
        data.elements.forEach(element => {
            if (element.type === 'way' && element.tags && element.tags.highway) {
                const wayCoordinates = element.nodes
                .map(nodeId => nodes.get(nodeId))
                .filter(coord => coord); // Filter out any undefined nodes
                roads.push(wayCoordinates);
            }
        });

        return roads;
    }
    ///
    self.addEventListener('message', async function(event) {
        if (event.data.type == 'fetchRoadData') {
            const bounds = event.data.data;
            console.log("received bounds: " + bounds);
            const query = `
    [out:json];
    way[highway][!aeroway][!building](${bounds}); // Filter to avoid airport taxiways and buildings
    (._;>;);
    out body;
    `;
            const url = `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(query)}`;

            try {
                const response = await fetch(url);
                if (!response.ok) {
                    throw new Error(`Error fetching data: ${response.statusText}`);
                }

                const data = await response.json();
                const coordinates = extractCoordinates(data);
                console.log('Road coordinates:', coordinates);
                updateRoads(coordinates);
            } catch (error) {
                console.error('Error:', error);
            }
        } else if (event.data.type == "removeCloseStreetLights") {
            var indices = removeCloseLights(event.data.data); //data should be rPos
            self.postMessage({type: "removeCloseStreetLights", data: indices});
        }
    });
};
//Main function
(function() {
    'use strict';
    window.roads = [];
    window.rPos = [];
    window.fPos = [];
    window.allSPos = []; //All Streetlight Positions
    window.isStLtOn = true;
    window.rdslastBounds;
    window.slLOD = false;
    window.ltTO = 0; //lightTimeOut, sets the timeout for light placing to hopefully reduce freezing
    window.streetLightWorker = new Worker(URL.createObjectURL(new Blob([`(${workerScript})()`], { type: 'application/javascript' })));
    window.streetLightWorker.addEventListener('message', function(event) {
        if (event.data.type == "addStreetlight") {
            addStreetlight(event.data.data[0], event.data.data[1]);
        } else if (event.data.type == "removeCloseStreetLights") {
            removeStreetLights(event.data.data);
        }
    });
    setInterval(() => {
        window.doRoads();
        setTimeout(() => {window.streetLightLOD();}, 3500);
    }, 8000);
})();
window.streetLightLOD = async function() {
    var ldgAGL = (window.geofs.animation.values.altitude !== undefined && window.geofs.animation.values.groundElevationFeet !== undefined) ? ((window.geofs.animation.values.altitude - window.geofs.animation.values.groundElevationFeet) + (window.geofs.aircraft.instance.collisionPoints[window.geofs.aircraft.instance.collisionPoints.length - 2].worldPosition[2]*3.2808399)) : 'N/A';
    var i;
    if (ldgAGL > 3000 && !window.slLOD) {
        window.slLOD = true;
        for (i = 0; i < window.roads.length; i++) {
            window.roads[i].model.uri = "https://raw.githubusercontent.com/tylerbmusic/GPWS-files_geofs/refs/heads/main/streetlight_lod.glb";
        }
    } else if (ldgAGL <= 3000 && window.slLOD) {
        window.slLOD = false;
        for (i = 0; i < window.roads.length; i++) {
            window.roads[i].model.uri = "https://raw.githubusercontent.com/tylerbmusic/GPWS-files_geofs/refs/heads/main/streetlight_coned.glb";
        }
    }
};
window.doRoads = async function() {
    window.ltTO = 0;
    var ldgAGL = (window.geofs.animation.values.altitude !== undefined && window.geofs.animation.values.groundElevationFeet !== undefined) ? ((window.geofs.animation.values.altitude - window.geofs.animation.values.groundElevationFeet) + (window.geofs.aircraft.instance.collisionPoints[window.geofs.aircraft.instance.collisionPoints.length - 2].worldPosition[2]*3.2808399)) : 'N/A';
    if (window.geofs.cautiousWithTerrain == false && (window.isStLtOn) && ldgAGL < 3000) {
        var renderDistance = 0.003; // Render distance, in degrees.
        var l0 = Math.floor(window.geofs.aircraft.instance.llaLocation[0] / renderDistance) * renderDistance;
        var l1 = Math.floor(window.geofs.aircraft.instance.llaLocation[1] / renderDistance) * renderDistance;
        window.bounds = (l0) + ", " + (l1) + ", " + (l0 + renderDistance) + ", " + (l1 + renderDistance);
        if (!window.rdslastBounds || (window.rdslastBounds != window.bounds)) {
            // Remove existing roads
            for (var i = 0; i < window.roads.length; i++) {
                window.geofs.api.viewer.entities.remove(window.roads[i]);
            }
            window.roads = [];
            console.log("Roads removed, placing new ones");
            // Place new roads
            console.log("bounds: " + window.bounds);
            window.streetLightWorker.postMessage({type: "fetchRoadData", data: window.bounds});
        }
        window.rdslastBounds = window.bounds;
    }
};

// Function to fetch road data from OSM using the Overpass API
async function removeStreetLights(arr) {
    console.log("removing Streetlights");
    for (var i in arr) {
        window.geofs.api.viewer.entities.remove(window.roads[arr[i]]);
    }
}


// Function to calculate distance between two coordinates in meters
function calculateDistance(coord1, coord2) {
    const [lat1, lon1] = coord1;
    const [lat2, lon2] = coord2;
    const earthRadius = 6371000; // Earth radius in meters

    const dLat = (lat2 - lat1) * (Math.PI / 180);
    const dLon = (lon2 - lon1) * (Math.PI / 180);

    const a = Math.sin(dLat / 2) ** 2 +
          Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
          Math.sin(dLon / 2) ** 2;

    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return earthRadius * c;
}
async function addStreetlight(position, heading) {
    window.ltTO += 1;
    setTimeout(() => {
        const apos = [position[1], position[0], window.geofs.api.viewer.scene.globe.getHeight(window.Cesium.Cartographic.fromDegrees(position[1], position[0]))];
        const pos = window.Cesium.Cartesian3.fromDegrees(apos[0], apos[1], apos[2]);

        // Adjust orientation based on the heading
        const hpr = new window.Cesium.HeadingPitchRoll(heading, 0, 0);
        const ori = window.Cesium.Transforms.headingPitchRollQuaternion(pos, hpr);
        window.rPos.push([position, window.roads.length]);
        window.roads.push(
            window.geofs.api.viewer.entities.add({
                name: "streetlight",
                position: pos,
                orientation: ori,
                model: {
                    uri: "https://raw.githubusercontent.com/tylerbmusic/GPWS-files_geofs/refs/heads/main/streetlight_coned.glb",
                    minimumPixelSize: 64,
                    maximumScale: 1
                },
                translucencyByDistance: new window.Cesium.NearFarScalar(1e2, 1.0, 5e2, 0.0)
            })
        );
    }, window.ltTO);
}
///
// Function to remove streetlights with x and y values within 5 of each other
window.removeCloseStreetlights = async function() {
    const cellSize = 5; // Grid cell size in meters
    const grid = new Map();
    const indicesToRemove = new Set();

    // Function to get a cell key
    const getCellKey = ([x, y]) => `${Math.floor(x / cellSize)},${Math.floor(y / cellSize)}`;

    // Populate grid with streetlights for spatial indexing
    for (let i = 0; i < window.rPos.length; i++) {
        const pos = window.rPos[i][0];
        const cellKey = getCellKey(pos);

        if (!grid.has(cellKey)) grid.set(cellKey, []);
        grid.get(cellKey).push(i);
    }

    // Check each cell and its neighbors
    for (let [cellKey, indices] of grid) {
        const [cellX, cellY] = cellKey.split(',').map(Number);

        // Check the cell and its 8 neighbors
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                const neighborKey = `${cellX + dx},${cellY + dy}`;
                const neighborIndices = grid.get(neighborKey) || [];

                for (let i = 0; i < indices.length; i++) {
                    const index1 = indices[i];
                    const pos1 = window.rPos[index1][0];

                    for (let j = 0; j < neighborIndices.length; j++) {
                        const index2 = neighborIndices[j];
                        if (index1 >= index2) continue;

                        const pos2 = window.rPos[index2][0];
                        const distance = calculateDistance(pos1, pos2);

                        if (distance <= 5) indicesToRemove.add(index2);
                    }
                }
            }
        }
    }

    // Batch remove streetlights in reverse order to avoid index shifting issues
    const sortedIndices = Array.from(indicesToRemove).sort((a, b) => b - a);
    for (const index of sortedIndices) {
        window.geofs.api.viewer.entities.remove(window.roads[index]);
    }

    // Clean up arrays
    for (const index of sortedIndices) {
        window.rPos.splice(index, 1);
        window.roads.splice(index, 1);
    }

    console.log(`${sortedIndices.length} streetlights removed.`);
};
